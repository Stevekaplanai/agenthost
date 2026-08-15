// Generates the 10 Signal Ledger seed-content cards (1080x1350) as HTML,
// then screenshots each to PNG via headless Chrome.
import { writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const FONTS = 'C:/Users/User/Projects/claimflow-videos/videos/claimflow-demo/capture/assets/fonts'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const shell = (body, eyebrow) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@font-face{font-family:'Instrument Serif';src:url('file:///${FONTS}/ccf27e5a7366fb23-s.1icgra-w5i50b.woff2') format('woff2');font-weight:400;}
@font-face{font-family:'Inter';src:url('file:///${FONTS}/2bbe8d2671613f1f-s.0k62hbripvv8p.woff2') format('woff2');font-weight:400;}
@font-face{font-family:'JetBrains Mono';src:url('file:///${FONTS}/13bf9871fe164e7f-s.2f7nqdagzwx2-.woff2') format('woff2');font-weight:400;}
:root{--paper:#faf9f6;--ink:#171a18;--pine:#135438;--pine-700:#1b6b49;--muted:#5c635e;--hairline:#e0e4df;}
*{margin:0;padding:0;box-sizing:border-box;}
body{width:1080px;height:1350px;background:var(--paper);font-family:'Inter',sans-serif;color:var(--ink);overflow:hidden;}
.frame{position:absolute;inset:36px;border:1.5px solid var(--hairline);pointer-events:none;}
.card{position:relative;width:100%;height:100%;padding:110px 96px 96px;display:flex;flex-direction:column;}
.eyebrow{font-family:'JetBrains Mono',monospace;font-size:22px;letter-spacing:0.22em;text-transform:uppercase;color:var(--pine);}
.footer{margin-top:auto;display:flex;justify-content:space-between;align-items:center;font-family:'JetBrains Mono',monospace;font-size:20px;letter-spacing:0.18em;color:var(--muted);}
.footer .dot{display:inline-block;width:14px;height:14px;border-radius:50%;background:var(--pine);margin-right:14px;vertical-align:-1px;}
.serif{font-family:'Instrument Serif',serif;font-weight:400;}
.mono{font-family:'JetBrains Mono',monospace;}
.rule{height:1.5px;background:var(--hairline);}
</style></head><body><div class="frame"></div><div class="card">
<div class="eyebrow">${eyebrow}</div>
${body}
<div class="footer"><span><span class="dot"></span>CLAIMFLOW</span><span>CLAIMFLOW.HEALTH</span></div>
</div></body></html>`

const cards = {
  g01: shell(`
    <div style="margin-top:210px">
      <div class="serif" style="font-size:104px;line-height:1.12">Compliance is<br>the wedge.</div>
      <div class="rule" style="width:120px;margin:56px 0;background:var(--pine);height:3px"></div>
      <div class="serif" style="font-size:104px;line-height:1.12;color:var(--pine);font-style:italic">Attribution is<br>the retention.</div>
    </div>`, 'The ClaimFlow thesis'),

  g02: shell(`
    <div style="margin-top:190px">
      <div class="mono" style="font-size:118px;color:var(--pine);letter-spacing:-0.01em">$145,000,000</div>
      <div class="serif" style="font-size:62px;line-height:1.25;margin-top:64px">The price two lead-gen giants paid for consent trails they couldn't&nbsp;produce.</div>
      <div class="mono" style="font-size:22px;color:var(--muted);margin-top:56px;letter-spacing:0.08em">FTC v. ASSURANCE IQ + MEDIAALPHA · AUGUST 2025</div>
    </div>`, 'Enforcement'),

  g03: shell(`
    <div class="serif" style="font-size:72px;line-height:1.15;margin-top:80px">Three dates that change what your call records must&nbsp;prove.</div>
    <div style="margin-top:80px;display:flex;flex-direction:column;gap:0">
      ${[
        ['OCT 1, 2026', 'The CY2027 rule takes effect. SOA-to-pitch in one call. The recording becomes the proof.'],
        ['OCT 15, 2026', 'AEP opens — into 2.6M displaced enrollees re-shopping. Fourteen days after the rules changed.'],
        ['JAN 31, 2027', 'One opt-out, any channel, revokes consent on every channel. One attribution record or bust.'],
      ].map(([d, t]) => `<div style="display:flex;gap:44px;padding:44px 0;border-top:1.5px solid var(--hairline)">
        <div class="mono" style="font-size:34px;color:var(--pine);white-space:nowrap;min-width:250px;padding-top:6px">${d}</div>
        <div style="font-size:31px;line-height:1.5;color:var(--ink)">${t}</div></div>`).join('')}
    </div>`, 'The regulatory calendar'),

  g04: shell(`
    <div class="serif" style="font-size:74px;line-height:1.16;margin-top:70px">Five things an auditor will ask your attribution system to&nbsp;prove.</div>
    <div style="margin-top:70px">
      ${[
        'Which source, campaign, and ad produced this enrollment',
        'That the disclaimer fired before benefits were discussed',
        'That consent traces to its original, related source',
        'That your comp data reconciles with the carrier’s attestation',
        'That you can re-produce all of it, identically, on demand',
      ].map((t, i) => `<div style="display:flex;gap:40px;align-items:baseline;padding:32px 0;border-top:1.5px solid var(--hairline)">
        <div class="mono" style="font-size:40px;color:var(--pine)">0${i + 1}</div>
        <div style="font-size:33px;line-height:1.45">${t}</div></div>`).join('')}
    </div>`, 'Audit readiness'),

  g05: shell(`
    <div class="serif" style="font-size:76px;line-height:1.15;margin-top:60px">Same 500 leads.<br>Different year&nbsp;one.</div>
    <div style="display:flex;gap:56px;margin-top:76px">
      ${[
        ['AGENCY A', 'var(--muted)', ['A spreadsheet and gut feel', 'Chargebacks eaten — no evidence', 'Comp data that can’t reconcile', 'Audits answered by archaeology']],
        ['AGENCY B', 'var(--pine)', ['Every enrollment traced to a call', 'Chargebacks disputed — and reversed', 'Sources ranked by persistency', 'Audits answered in minutes']],
      ].map(([name, color, rows]) => `<div style="flex:1">
        <div class="mono" style="font-size:26px;letter-spacing:0.18em;color:${color};padding-bottom:24px;border-bottom:3px solid ${color}">${name}</div>
        ${rows.map(r => `<div style="font-size:29px;line-height:1.42;padding:30px 0;border-bottom:1.5px solid var(--hairline)">${r}</div>`).join('')}
      </div>`).join('')}
    </div>`, 'The attribution gap'),

  g06: shell(`
    <div class="serif" style="font-size:76px;line-height:1.15;margin-top:40px">Your marketing isn’t&nbsp;flat.<br>Why is your dashboard?</div>
    <div style="display:flex;justify-content:center;margin-top:60px">
      <svg width="640" height="640" viewBox="0 0 640 640">
        <circle cx="320" cy="320" r="300" fill="none" stroke="#171a18" stroke-width="2.5"/>
        <path d="M 108 108 A 300 300 0 0 0 108 532" fill="none" stroke="#e0e4df" stroke-width="2" transform="rotate(0 320 320)"/>
        ${[30, 75, 120, 165, 210, 255, 300, 345].map(a => `<path d="M 320 20 A 424 424 0 0 1 620 320" fill="none" stroke="#e0e4df" stroke-width="1.8" transform="rotate(${a} 320 320)"/>`).join('')}
        <circle cx="320" cy="320" r="14" fill="#135438"/>
        ${[[0, 'A'], [72, 'B'], [144, 'C'], [216, 'D'], [288, 'E']].map(([a]) => {
          const rad = (a - 90) * Math.PI / 180
          const x = 320 + 135 * Math.cos(rad), y = 320 + 135 * Math.sin(rad)
          return `<line x1="320" y1="320" x2="${x}" y2="${y}" stroke="#135438" stroke-width="1.5" opacity="0.5"/><circle cx="${x}" cy="${y}" r="9" fill="#1b6b49"/>`
        }).join('')}
        ${[[0], [72], [144], [216], [288]].map(([a]) => {
          const pts = []
          for (let i = -2; i <= 2; i++) {
            const rad = (a - 90 + i * 11) * Math.PI / 180
            const rr = 232 + Math.abs(i) * 16
            pts.push(`<circle cx="${320 + rr * Math.cos(rad)}" cy="${320 + rr * Math.sin(rad)}" r="5" fill="#135438" opacity="0.75"/>`)
          }
          return pts.join('')
        }).join('')}
      </svg>
    </div>
    <div style="font-size:28px;line-height:1.5;color:var(--muted);margin-top:52px;max-width:800px">Hierarchies live naturally in curved (hyperbolic) space — roots at the center, every call at the rim. AI research adopted it in 2017. We pointed it at attribution.</div>`, 'Attribution in curved space'),

  g07: shell(`
    <div class="serif" style="font-size:78px;line-height:1.16;margin-top:40px">The five-minute trace&nbsp;test.</div>
    <div style="font-size:31px;line-height:1.5;color:var(--muted);margin-top:36px;max-width:820px">Pick any enrollment from last month. Can you walk this chain — with the recording at the end — in under five minutes?</div>
    <div style="margin-top:48px">
      ${['Source', 'Campaign', 'Ad', 'Call recording', 'Enrollment'].map((t, i, arr) => `
        <div style="display:flex;align-items:center;gap:36px;padding:18px 0">
          <div class="mono" style="font-size:24px;color:var(--pine);min-width:56px">0${i + 1}</div>
          <div class="serif" style="font-size:46px">${t}</div>
        </div>${i < arr.length - 1 ? '<div style="margin-left:16px;color:var(--pine);font-size:30px;line-height:0.5">↓</div>' : ''}`).join('')}
    </div>
    <div style="font-size:27px;color:var(--muted);margin-top:44px">If any hop takes longer, it doesn’t exist under audit pressure.</div>`, 'Self-audit'),

  g08: shell(`
    <div style="margin-top:250px">
      <div class="serif" style="font-size:96px;line-height:1.18">Audit-ready in <span style="color:var(--pine)">30 days</span>, or we keep working&nbsp;<span style="font-style:italic">free</span>.</div>
      <div class="rule" style="width:120px;height:3px;background:var(--pine);margin:64px 0"></div>
      <div style="font-size:31px;line-height:1.55;color:var(--muted);max-width:820px">The ClaimFlow pilot guarantee: if your first CMS-facing attribution report isn’t audit-ready within 30 days of connection, we work at no charge until it is.</div>
    </div>`, 'The guarantee'),

  g09: shell(`
    <div style="margin-top:130px">
      <div class="mono" style="font-size:24px;letter-spacing:0.2em;color:var(--muted)">NEW WHITEPAPER</div>
      <div class="serif" style="font-size:110px;line-height:1.1;margin-top:36px">Attribution<br>in Curved<br>Space</div>
      <div style="font-size:31px;line-height:1.55;color:var(--muted);margin-top:56px;max-width:800px">The Poincaré playbook for audit-proof Medicare lead attribution — and why the geometry your dashboard uses is about to matter to CMS.</div>
      <div style="margin-top:64px">
        ${['The 2026 regulatory collision, dated and sourced', 'Why flat attribution models distort hierarchies', 'The first application of Poincaré embeddings to attribution', 'The five-question self-audit + 27-item AEP checklist'].map(t => `<div style="display:flex;gap:26px;align-items:baseline;font-size:29px;line-height:1.45;padding:16px 0"><span style="color:var(--pine);font-size:26px">→</span><span>${t}</span></div>`).join('')}
      </div>
    </div>`, 'claimflow.health/whitepaper'),

  g10: shell(`
    <div style="margin-top:150px">
      <div style="display:flex;gap:64px;align-items:baseline">
        <div>
          <div class="mono" style="font-size:98px;color:var(--ink)">OCT 1</div>
          <div style="font-size:28px;color:var(--muted);margin-top:18px">The rules change.</div>
        </div>
        <div class="serif" style="font-size:64px;color:var(--pine)">→</div>
        <div>
          <div class="mono" style="font-size:98px;color:var(--pine)">OCT 15</div>
          <div style="font-size:28px;color:var(--muted);margin-top:18px">AEP opens.</div>
        </div>
      </div>
      <div class="rule" style="margin:80px 0"></div>
      <div class="serif" style="font-size:80px;line-height:1.2">Two weeks to retrain scripts, re-time disclaimers, and re-tag every lead&nbsp;source.</div>
      <div style="font-size:30px;line-height:1.5;color:var(--muted);margin-top:56px">Connected in August means your biggest quarter is the one that’s fully attributed.</div>
    </div>`, 'AEP 2027 countdown'),
}

for (const [name, html] of Object.entries(cards)) {
  writeFileSync(`${name}.html`, html)
  execSync(`"${CHROME}" --headless=new --disable-gpu --hide-scrollbars --screenshot="${process.cwd()}\\${name}.png" --window-size=1080,1350 "file:///${process.cwd().replace(/\\/g, '/')}/${name}.html"`, { stdio: 'pipe', timeout: 60000 })
  console.log(name, 'done')
}
console.log('all graphics rendered')
