#!/usr/bin/python3
"""Build Graphify's initial graph from one already-sanitized folder snapshot.

The regular Graphify CLI classifies Markdown as a semantic/model input even
though the pinned package ships a deterministic Markdown/wiki-link extractor.
AgentHost calls that local extractor directly so code, configs, and vault notes
share one credential-free, networkless pipeline.
"""

from __future__ import annotations

import hashlib
import importlib.metadata as metadata
import json
import os
import re
import sys
import tomllib
from pathlib import Path


GRAPHIFY_PACKAGE = Path("/graphify")
EXPECTED_VERSION = "0.9.42"
SUPPORTED = {
    ".py", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
    ".go", ".rs", ".java", ".groovy", ".gradle", ".c", ".h", ".cpp", ".cc",
    ".cxx", ".hpp", ".rb", ".rake", ".cs", ".kt", ".kts", ".scala", ".php",
    ".swift", ".lua", ".zig", ".ps1", ".psm1", ".psd1", ".ex", ".exs", ".m",
    ".mm", ".jl", ".f", ".f90", ".f95", ".f03", ".f08", ".vue", ".svelte",
    ".astro", ".dart", ".v", ".sv", ".svh", ".sql", ".md", ".mdx", ".qmd",
    ".skill", ".sh", ".bash", ".json", ".tf", ".tfvars", ".hcl", ".sln",
    ".slnx", ".csproj", ".fsproj", ".vbproj", ".xaml", ".razor", ".cshtml",
    ".cls", ".trigger",
}
CONFIG_ONLY = {".toml", ".yaml", ".yml"}
MARKDOWN = {".md", ".mdx", ".qmd", ".skill"}
WIKILINK_RE = re.compile(r"(?<!!)\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]")
FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
KEY_LINE_RE = re.compile(r"^\s*([A-Za-z0-9_.-]{1,100})\s*[:=]")


def stable_id(prefix: str, value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:20]
    return f"agenthost_{prefix}_{digest}"


def relative(root: Path, file: Path) -> str:
    return file.relative_to(root).as_posix()


def regular_files(root: Path) -> list[Path]:
    result: list[Path] = []
    for directory, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        here = Path(directory)
        dirnames[:] = sorted(
            name for name in dirnames
            if not (here / name).is_symlink() and name != "graphify-out"
        )
        for name in sorted(filenames):
            file = here / name
            if name == ".agenthost-corpus.json" or file.is_symlink() or not file.is_file():
                continue
            if file.suffix.lower() in SUPPORTED | CONFIG_ONLY:
                result.append(file)
    return sorted(result, key=lambda item: relative(root, item).casefold())


def folder_structure(root: Path, files: list[Path], known_file_ids: dict[str, str]) -> tuple[list[dict], list[dict]]:
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    seen_edges: set[tuple[str, str, str]] = set()

    def add_folder(folder_rel: str) -> str:
        normalized = folder_rel.strip("/") or "."
        node_id = stable_id("folder", normalized)
        nodes.setdefault(node_id, {
            "id": node_id,
            "label": Path(normalized).name if normalized != "." else root.name,
            "file_type": "concept",
            "source_file": normalized,
            "source_location": "folder",
            "agenthost_kind": "folder",
            "_origin": "ast",
        })
        if normalized != ".":
            parent = Path(normalized).parent.as_posix()
            parent_id = add_folder(parent)
            key = (parent_id, node_id, "contains")
            if key not in seen_edges:
                seen_edges.add(key)
                edges.append({
                    "source": parent_id, "target": node_id, "relation": "contains",
                    "confidence": "EXTRACTED", "source_file": normalized,
                    "source_location": "folder", "weight": 1.0, "_origin": "ast",
                })
        return node_id

    add_folder(".")
    for file in files:
        rel = relative(root, file)
        folder_id = add_folder(Path(rel).parent.as_posix())
        file_id = known_file_ids.get(rel) or stable_id("file", rel)
        if rel not in known_file_ids:
            nodes.setdefault(file_id, {
                "id": file_id, "label": file.name, "file_type": "document" if file.suffix.lower() in MARKDOWN else "code",
                "source_file": rel, "source_location": "L1", "agenthost_kind": "file", "_origin": "ast",
            })
        key = (folder_id, file_id, "contains")
        if key not in seen_edges:
            seen_edges.add(key)
            edges.append({
                "source": folder_id, "target": file_id, "relation": "contains",
                "confidence": "EXTRACTED", "source_file": rel,
                "source_location": "L1", "weight": 1.0, "_origin": "ast",
            })
    return list(nodes.values()), edges


def config_structure(root: Path, files: list[Path]) -> tuple[list[dict], list[dict]]:
    nodes: list[dict] = []
    edges: list[dict] = []
    for file in files:
        if file.suffix.lower() not in CONFIG_ONLY:
            continue
        rel = relative(root, file)
        file_id = stable_id("file", rel)
        keys: set[str] = set()
        try:
            text = file.read_text(encoding="utf-8", errors="strict")
            if file.suffix.lower() == ".toml":
                value = tomllib.loads(text)

                def walk(node, prefix=""):
                    if not isinstance(node, dict):
                        return
                    for key, child in node.items():
                        joined = f"{prefix}.{key}" if prefix else str(key)
                        keys.add(joined[:200])
                        walk(child, joined)

                walk(value)
            else:
                for line in text.splitlines():
                    match = KEY_LINE_RE.match(line)
                    if match:
                        keys.add(match.group(1))
        except (OSError, UnicodeError, tomllib.TOMLDecodeError) as exc:
            raise RuntimeError(f"config extraction failed for {rel}: {exc}") from exc
        for key in sorted(keys):
            key_id = stable_id("config", f"{rel}:{key}")
            nodes.append({
                "id": key_id, "label": key, "file_type": "concept", "source_file": rel,
                "source_location": "config", "agenthost_kind": "config-key", "_origin": "ast",
            })
            edges.append({
                "source": file_id, "target": key_id, "relation": "contains",
                "confidence": "EXTRACTED", "source_file": rel,
                "source_location": "config", "weight": 1.0, "_origin": "ast",
            })
    return nodes, edges


def merge_records(target: list[dict], additions: list[dict], key) -> None:
    seen = {key(item) for item in target}
    for item in additions:
        identity = key(item)
        if identity not in seen:
            seen.add(identity)
            target.append(item)


def file_node_ids(nodes: list[dict]) -> dict[str, str]:
    result: dict[str, str] = {}
    for node in nodes:
        source = node.get("source_file")
        if not isinstance(source, str) or not source:
            continue
        if node.get("agenthost_kind") == "file" or node.get("source_location") == "L1":
            result.setdefault(source.replace("\\", "/"), str(node.get("id")))
    return result


def markdown_without_fenced_blocks(text: str) -> str:
    """Mask fenced examples while preserving offsets and line numbers."""
    result: list[str] = []
    fence: tuple[str, int] | None = None
    for line in text.splitlines(keepends=True):
        match = FENCE_RE.match(line)
        if fence is None and match:
            marker = match.group(1)
            fence = (marker[0], len(marker))
            result.append("".join(char if char in "\r\n" else " " for char in line))
            continue
        if fence is not None:
            closing = re.match(rf"^ {{0,3}}{re.escape(fence[0])}{{{fence[1]},}}\s*$", line.rstrip("\r\n"))
            result.append("".join(char if char in "\r\n" else " " for char in line))
            if closing:
                fence = None
            continue
        result.append(line)
    return "".join(result)


def add_wikilinks(root: Path, files: list[Path], nodes: list[dict], edges: list[dict]) -> None:
    markdown = [file for file in files if file.suffix.lower() in MARKDOWN]
    file_ids = file_node_ids(nodes)
    by_rel: dict[str, list[str]] = {}
    by_name: dict[str, list[str]] = {}
    for file in markdown:
        rel = relative(root, file)
        no_ext = str(Path(rel).with_suffix("")).replace("\\", "/").casefold()
        by_rel.setdefault(no_ext, []).append(rel)
        by_name.setdefault(Path(no_ext).name, []).append(rel)
    seen = {
        (str(edge.get("source")), str(edge.get("target")), str(edge.get("relation")), str(edge.get("confidence")))
        for edge in edges
    }
    for file in markdown:
        rel = relative(root, file)
        source_id = file_ids.get(rel)
        if not source_id:
            continue
        try:
            text = file.read_text(encoding="utf-8", errors="strict")
        except (OSError, UnicodeError) as exc:
            raise RuntimeError(f"wiki-link extraction failed for {rel}: {exc}") from exc
        visible_text = markdown_without_fenced_blocks(text)
        for match in WIKILINK_RE.finditer(visible_text):
            raw = match.group(1).strip().replace("\\", "/")
            if not raw:
                continue
            candidate = str((Path(rel).parent / raw).with_suffix("")).replace("\\", "/").casefold()
            root_candidate = str(Path(raw).with_suffix("")).replace("\\", "/").casefold()
            matches = list(dict.fromkeys(by_rel.get(candidate, []) + by_rel.get(root_candidate, []) + by_name.get(Path(root_candidate).name, [])))
            confidence = "EXTRACTED" if len(matches) == 1 else "AMBIGUOUS"
            if not matches:
                target_id = stable_id("unresolved", raw.casefold())
                merge_records(nodes, [{
                    "id": target_id, "label": raw[:160], "file_type": "concept",
                    "agenthost_kind": "unresolved-link", "_origin": "ast",
                }], lambda item: str(item.get("id")))
                matches = [None]
            for target_rel in matches:
                target_id = file_ids.get(target_rel) if target_rel else stable_id("unresolved", raw.casefold())
                if not target_id or target_id == source_id:
                    continue
                record = (source_id, target_id, "references", confidence)
                if record in seen:
                    continue
                seen.add(record)
                line = text.count("\n", 0, match.start()) + 1
                edges.append({
                    "source": source_id, "target": target_id, "relation": "references",
                    "confidence": confidence, "source_file": rel,
                    "source_location": f"L{line}", "weight": 1.0, "_origin": "ast",
                })


def apply_graph_metadata(root: Path, nodes: list[dict]) -> None:
    manifest = root / ".agenthost-corpus.json"
    if not manifest.is_file():
        return
    try:
        raw = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"corpus metadata is invalid: {exc}") from exc
    files = raw.get("files", {}) if isinstance(raw, dict) else {}
    if not isinstance(files, dict):
        raise RuntimeError("corpus metadata files must be an object")
    canonical_file_ids = file_node_ids(nodes)
    for node in nodes:
        source = node.get("source_file")
        normalized_source = source.replace("\\", "/") if isinstance(source, str) else ""
        if not normalized_source or canonical_file_ids.get(normalized_source) != str(node.get("id")):
            continue
        metadata_record = files.get(normalized_source)
        if not isinstance(metadata_record, dict):
            continue
        if isinstance(metadata_record.get("asset"), str):
            node["asset"] = metadata_record["asset"][:64]
        claims = metadata_record.get("claims")
        if isinstance(claims, list):
            node["claims"] = claims


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: graphify-folder-extract.py SOURCE OUTPUT", file=sys.stderr)
        return 2
    sys.path.insert(0, str(GRAPHIFY_PACKAGE))
    actual = metadata.version("graphifyy")
    if actual != EXPECTED_VERSION:
        raise RuntimeError(f"Graphify identity mismatch: expected graphifyy=={EXPECTED_VERSION}, found {actual}")
    from graphify.extract import extract

    root = Path(sys.argv[1]).resolve(strict=True)
    output = Path(sys.argv[2])
    files = regular_files(root)
    if not files:
        raise RuntimeError("Graphify snapshot contains no supported files")
    graphify_files = [file for file in files if file.suffix.lower() in SUPPORTED]
    result = extract(
        graphify_files,
        cache_root=output.parent / "cache",
        root=root,
        parallel=False,
        max_workers=1,
    ) if graphify_files else {"nodes": [], "edges": []}
    nodes = list(result.get("nodes", []))
    edges = list(result.get("edges", []))
    folder_nodes, folder_edges = folder_structure(root, files, file_node_ids(nodes))
    config_nodes, config_edges = config_structure(root, files)
    merge_records(nodes, folder_nodes + config_nodes, lambda item: str(item.get("id")))
    merge_records(edges, folder_edges + config_edges, lambda item: (
        str(item.get("source")), str(item.get("target")), str(item.get("relation")), str(item.get("confidence"))
    ))
    add_wikilinks(root, files, nodes, edges)
    apply_graph_metadata(root, nodes)
    output.parent.mkdir(parents=True, exist_ok=True)
    document = {
        "directed": True,
        "multigraph": True,
        "graph": {},
        "nodes": nodes,
        "links": edges,
        "hyperedges": result.get("hyperedges", []),
    }
    output.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
