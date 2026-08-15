# Real Windows PowerShell 5.1 -> WSL argv round-trip test.
# The coordinator runs in dry-run mode: no lifecycle claim, worktree, branch,
# provider request, or model inference is created.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $repositoryRoot "scripts\start-local-room.ps1"
$controlPlaneLauncher = Join-Path $repositoryRoot "control-plane\start-local.ps1"
$stateRootResolver = Join-Path $repositoryRoot "scripts\room-state-root.ps1"
$launcherSource = Get-Content -Raw -LiteralPath $launcher
$controlPlaneSource = Get-Content -Raw -LiteralPath $controlPlaneLauncher
$stateRootSource = Get-Content -Raw -LiteralPath $stateRootResolver

foreach ($required in @(
    "Claude/Codex/Hermes/Kimi",
    '"--lifecycle-adapter"',
    '"--lifecycle-url"',
    '"--lifecycle-token-stdin"',
    '"--recover-quarantine"',
    '"--state-dir"',
    '"--control-root"',
    '[ValidateSet("Ubuntu")]',
    "RecoverQuarantine requires -StateDir",
    "LifecycleUrl is required unless -DryRun is used.",
    "Get-CanonicalLifecycleUrl",
    "scripts\local-room\kanban-lifecycle-adapter.mjs",
    'exec /usr/bin/env -i "WSL_INTEROP=$WSL_INTEROP" "$@"',
    "/run/WSL/*_interop",
    '$startInfo.RedirectStandardInput = $true',
    '[System.Text.Encoding]::ASCII.GetBytes("$controllerInputBase64`n")',
    "Get-PrivateProviderEnvironment",
    "KIMI_CODE_HOME",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "providerEnvironment = `$privateProviderEnvironment",
    "ConvertTo-Json -Compress",
    'ConvertTo-ProcessArgument -Value "$_"',
    "[Environment]::SystemDirectory",
    "[ValidateRange(1024, 65535)]",
    '$agentglassHealthUrl = "http://127.0.0.1:$DashboardPort/health"',
    '$agentglassIngestUrl = "http://127.0.0.1:$DashboardPort/ingest"'
)) {
    if (-not $launcherSource.Contains($required)) {
        throw "Launcher is missing required contract text: $required"
    }
}
if ($launcherSource.Contains("WSLENV") -or
    $launcherSource.Contains("KIMI_API_KEY") -or
    $launcherSource.Contains("AGENTHOST_KANBAN_LIFECYCLE_TOKEN") -or
    $launcherSource.Contains('Get-Command "wsl.exe"') -or
    $launcherSource.Contains('Get-Command "curl.exe"')) {
    throw "Launcher can leak a token through the environment or resolve an untrusted executable."
}
$alternateDistroRejected = $false
try {
    & $launcher -Objective "reject alternate distro" -Distro "Debian" -DryRun `
        6>&1 2>&1 | Out-Null
} catch {
    $alternateDistroRejected = $_.Exception.Message -match
        "does not belong to the set"
}
if (-not $alternateDistroRejected) {
    throw "An alternate WSL distro could bypass the single-host room guard."
}
if ($launcherSource -notmatch '\$curlExe\s+"--disable"' -or
    -not $launcherSource.Contains('"--max-filesize" "1024"') -or
    -not $launcherSource.Contains('$serviceProperty.Value -ceq "agentglass"')) {
    throw "Optional telemetry health check is not pinned and bounded."
}
foreach ($source in @($launcherSource, $controlPlaneSource)) {
    if (-not $source.Contains(". `$stateRootResolver") -or
        -not $source.Contains("Resolve-AgentHostRoomStateRoot")) {
        throw "Both launchers must use the shared room-state resolver."
    }
}
if (-not $controlPlaneSource.Contains(
        '$env:AGENTHOST_ROOM_STATE_ROOT = $roomStateRoot.WindowsPath'
    )) {
    throw "The control plane does not pass the normalized shared root to AgentGlass."
}
foreach ($required in @(
    "LocalApplicationData",
    "AgentHost\rooms",
    "SetAccessRuleProtection",
    "Room state root must be separate from the repository.",
    "must not contain a junction or symbolic link"
)) {
    if (-not $stateRootSource.Contains($required)) {
        throw "Room state resolver is missing required safety text: $required"
    }
}

$parseTokens = $null
$parseErrors = $null
$launcherAst = [System.Management.Automation.Language.Parser]::ParseFile(
    $launcher,
    [ref]$parseTokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    throw "Launcher has PowerShell parse errors: $($parseErrors -join '; ')"
}
foreach ($functionName in @(
    "Get-AbsoluteWslPath",
    "Resolve-WslRoomStateRoot",
    "ConvertTo-NativeQuotedArgument",
    "ConvertTo-ProcessArgument"
)) {
    $functionAst = $launcherAst.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $functionName
    }, $true)
    if ($null -eq $functionAst) {
        throw "Could not find launcher argument serializer '$functionName'."
    }
    Invoke-Expression $functionAst.Extent.Text
}
if ((ConvertTo-ProcessArgument -Value "-d") -cne "-d" -or
    (ConvertTo-ProcessArgument -Value "two words") -cne '"two words"') {
    throw "Launcher argument serializer corrupts WSL arguments."
}
$customRecoveryRoot = "/var/lib/agenthost/custom-rooms"
$customRecoveryStateDir = "$customRecoveryRoot/agenthost-room-recovery-test"
$inferredRecoveryRoot = Resolve-WslRoomStateRoot `
    -RequestedRoot "" `
    -RequestedStateDir $customRecoveryStateDir `
    -WslHome "/home/sk777" `
    -RecoverQuarantine
if ($inferredRecoveryRoot -cne $customRecoveryRoot) {
    throw "Recovery without -StateRoot did not infer the exact custom state parent."
}
if (-not $launcherSource.Contains('"--state-root", $wslStateRoot')) {
    throw "The inferred recovery state root is not passed to the WSL coordinator."
}

$rocket = [char]::ConvertFromUtf32(0x1F680)
$objective = 'Review "quoted plan"; literal $() & pipe | path C:\tmp\ ' + $rocket
$bytes = [System.Text.Encoding]::UTF8.GetBytes($objective)
$sha = [System.Security.Cryptography.SHA256]::Create()
try {
    $expectedHash = ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant().Substring(0, 12)
} finally {
    $sha.Dispose()
}

$captured = New-Object System.Collections.Generic.List[string]
$sourceRepository = "C:\Users\User\Projects\agenthost-internal"
$fixtureBin = Join-Path $PSScriptRoot "fixtures\local-room-bin"
$fixtureControlRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    "agenthost control launcher test $PID"
)
$fixtureStateRoot = "/tmp/agenthost-room-launcher-test-$PID"
$fixtureStateDir = "$fixtureStateRoot/agenthost-room-resume-path"
if (-not (Test-Path -LiteralPath (Join-Path $sourceRepository ".git") -PathType Container)) {
    throw "PowerShell-to-WSL test source repository is unavailable: $sourceRepository"
}
$priorStateRoot = [Environment]::GetEnvironmentVariable(
    "AGENTHOST_ROOM_STATE_ROOT",
    "Process"
)
$launchError = $null
try {
    [Environment]::SetEnvironmentVariable(
        "AGENTHOST_ROOM_STATE_ROOT",
        $fixtureControlRoot,
        "Process"
    )
    & $launcher -Objective $objective -Rounds 1 -WorkingDirectory $sourceRepository `
        -StateRoot $fixtureStateRoot -StateDir $fixtureStateDir `
        -BinDirectory $fixtureBin -DryRun 6>&1 2>&1 |
        ForEach-Object { $captured.Add("$_") }
} catch {
    $launchError = "Launcher failed: $($_.Exception.Message). Output: $($captured -join [Environment]::NewLine)"
} finally {
    if ($null -eq $priorStateRoot) {
        [Environment]::SetEnvironmentVariable(
            "AGENTHOST_ROOM_STATE_ROOT",
            $null,
            "Process"
        )
    } else {
        [Environment]::SetEnvironmentVariable(
            "AGENTHOST_ROOM_STATE_ROOT",
            $priorStateRoot,
            "Process"
        )
    }
}
if ($null -ne $launchError) {
    if (Test-Path -LiteralPath $fixtureControlRoot) {
        Remove-Item -LiteralPath $fixtureControlRoot -Recurse -Force
    }
    throw $launchError
}
try {
    $rendered = @($captured) -join [Environment]::NewLine
    $expected = "Objective: $($bytes.Length) UTF-8 bytes - sha256 $expectedHash"
    if (-not $rendered.Contains($expected)) {
        throw "Objective changed crossing PowerShell 5.1 -> WSL. Expected '$expected'. Output: $rendered"
    }
    if (-not $rendered.Contains("Agents: Claude -> Codex -> Hermes -> Kimi (sequential)") -or
        -not $rendered.Contains("Dry run passed. No worktree, branch, lifecycle claim, or agent inference was created.")) {
        throw "Four-agent dry run did not complete. Output: $rendered"
    }
    if ($rendered -match 'l{32}' -or $rendered.Contains("stopNonce")) {
        throw "A lifecycle or emergency-stop secret leaked into launcher output."
    }
    if (-not $rendered.Contains("Room execution state (WSL): $fixtureStateRoot") -or
        -not $rendered.Contains("Dashboard control (Windows): $fixtureControlRoot")) {
        throw "PowerShell and WSL did not keep execution and dashboard-control state separate. Output: $rendered"
    }
    if (-not $rendered.Contains("Restarting room state: $fixtureStateDir") -or
        -not $rendered.Contains("State directory: $fixtureStateDir")) {
        throw "The explicit restart state directory did not cross PowerShell 5.1 -> WSL intact. Output: $rendered"
    }

    . $stateRootResolver
    $expectedDefault = Join-Path (
        [Environment]::GetFolderPath(
            [Environment+SpecialFolder]::LocalApplicationData
        )
    ) "AgentHost\rooms"
    if ((Get-AgentHostDefaultRoomStateRoot) -cne $expectedDefault) {
        throw "Default room state is not the Windows user-local AgentHost directory."
    }
    if (-not (Test-Path -LiteralPath $fixtureControlRoot -PathType Container)) {
        throw "The Windows dashboard-control directory was not created."
    }
    $stateAcl = [System.IO.Directory]::GetAccessControl($fixtureControlRoot)
    if (-not $stateAcl.AreAccessRulesProtected) {
        throw "The dashboard-control directory still inherits broader Windows access."
    }

    foreach ($invalidLeaf in @("agenthost room invalid", "AgentHost-room-uppercase")) {
        $invalidStateDir = "$fixtureStateRoot/$invalidLeaf"
        $invalidStateDirRejected = $false
        try {
            & $launcher -Objective "reject invalid state directory" -Rounds 1 `
                -WorkingDirectory $sourceRepository -StateRoot $fixtureStateRoot `
                -ControlRoot $fixtureControlRoot `
                -StateDir $invalidStateDir -BinDirectory $fixtureBin -DryRun `
                6>&1 2>&1 | Out-Null
        } catch {
            $invalidStateDirRejected = $_.Exception.Message -match
                "Room state directory name must match"
        }
        if (-not $invalidStateDirRejected) {
            throw "A room directory invisible to the dashboard scanner was accepted: $invalidLeaf"
        }
    }
    $nestedStateDir = "$fixtureStateRoot/nested/agenthost-room-valid"
    $nestedStateDirRejected = $false
    try {
        & $launcher -Objective "reject nested state directory" -Rounds 1 `
            -WorkingDirectory $sourceRepository -StateRoot $fixtureStateRoot `
            -ControlRoot $fixtureControlRoot `
            -StateDir $nestedStateDir -BinDirectory $fixtureBin -DryRun `
            6>&1 2>&1 | Out-Null
    } catch {
        $nestedStateDirRejected = $_.Exception.Message -match
            "must be a direct child"
    }
    if (-not $nestedStateDirRejected) {
        throw "A nested room directory invisible to the dashboard scanner was accepted."
    }
    $mountedStateRejected = $false
    try {
        & $launcher -Objective "reject mounted execution state" -Rounds 1 `
            -WorkingDirectory $sourceRepository -StateRoot "/mnt/c/tmp/agenthost-room" `
            -ControlRoot $fixtureControlRoot -BinDirectory $fixtureBin -DryRun `
            6>&1 2>&1 | Out-Null
    } catch {
        $mountedStateRejected = $_.Exception.Message -match "WSL-native storage"
    }
    if (-not $mountedStateRejected) {
        throw "Mounted Windows storage was accepted for agent worktrees."
    }

    foreach ($unsafeLifecycleUrl in @(
        "https://user:secret@box.tailnet.ts.net/kanban",
        "https://box.tailnet.ts.net/kanban?token=secret",
        "https://box.tailnet.ts.net:4443/kanban",
        "https://box.tailnet.ts.net.evil.example/kanban"
    )) {
        $unsafeLifecycleRejected = $false
        try {
            & $launcher -Objective "reject unsafe lifecycle URL" -Rounds 1 `
                -WorkingDirectory $sourceRepository -StateRoot $fixtureStateRoot `
                -ControlRoot $fixtureControlRoot -LifecycleUrl $unsafeLifecycleUrl `
                -BinDirectory $fixtureBin 6>&1 2>&1 | Out-Null
        } catch {
            $unsafeLifecycleRejected = $_.Exception.Message -match "LifecycleUrl must be"
        }
        if (-not $unsafeLifecycleRejected) {
            throw "An unsafe lifecycle URL reached process launch: $unsafeLifecycleUrl"
        }
    }

    $firstRun = @(
        & $launcher -Objective "first run restart path" -Rounds 1 `
            -WorkingDirectory $sourceRepository -StateRoot $fixtureStateRoot `
            -ControlRoot $fixtureControlRoot -BinDirectory $fixtureBin -DryRun `
            6>&1 2>&1
    ) -join [Environment]::NewLine
    if ($firstRun -notmatch (
        "State directory: " +
        [regex]::Escape("$fixtureStateRoot/agenthost-room-") +
        "[A-Za-z0-9._-]+"
    )) {
        throw "First launch did not print a copy-pasteable WSL -StateDir path. Output: $firstRun"
    }

    foreach ($unsafe in @(".\rooms", $repositoryRoot)) {
        $rejected = $false
        try {
            Resolve-AgentHostRoomStateRoot `
                -RequestedPath $unsafe `
                -RepositoryRoot $repositoryRoot | Out-Null
        } catch {
            $rejected = $true
        }
        if (-not $rejected) {
            throw "Unsafe room-state path was accepted: $unsafe"
        }
    }
} finally {
    if (Test-Path -LiteralPath $fixtureControlRoot) {
        Remove-Item -LiteralPath $fixtureControlRoot -Recurse -Force
    }
}

Write-Output "PowerShell 5.1 -> WSL four-agent dry-run transport passed."
