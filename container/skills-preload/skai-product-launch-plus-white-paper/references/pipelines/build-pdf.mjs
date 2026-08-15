// Builds whitepaper.html (Signal Ledger print styling, embedded brand fonts)
// from body-fragment.html, then prints to PDF via headless Chrome.
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const FONT_DIR = 'C:/Users/User/Projects/claimflow-videos/videos/claimflow-demo/capture/assets/fonts/'
const fonts = {
  'Instrument Serif': 'ccf27e5a7366fb23-s.1icgra-w5i50b.woff2',
  Inter: '2bbe8d2671613f1f-s.0k62hbripvv8p.woff2',
  'JetBrains Mono': '13bf9871fe164e7f-s.2f7nqdagzwx2-.woff2',
}
const face = (family, file) =>
  `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${readFileSync(FONT_DIR + file).toString('base64')}) format('woff2');font-weight:400;font-style:normal;}`

const body = readFileSync('body-fragment.html', 'utf8')

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Attribution in Curved Space — ClaimFlow Whitepaper</title><style>
${Object.entries(fonts).map(([f, file]) => face(f, file)).join('\n')}
:root{--pine:#135438;--pine-700:#1b6b49;--ink:#171a18;--muted:#5c635e;--hairline:#e3e7e3;--surface:#f6f7f5;}
*{box-sizing:border-box;}
@page{size:letter;margin:0.85in 0.9in;}
body{font-family:'Inter',system-ui,sans-serif;color:var(--ink);font-size:10.5pt;line-height:1.62;margin:0;}
h1{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:30pt;line-height:1.08;letter-spacing:-0.01em;color:var(--ink);margin:0 0 10pt;}
h1+h2{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:15pt;line-height:1.3;color:var(--pine);border:none;margin:0 0 14pt;padding:0;}
h2{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:18pt;line-height:1.2;color:var(--ink);margin:26pt 0 8pt;padding-top:14pt;border-top:1px solid var(--hairline);page-break-after:avoid;}
h3{font-family:'Inter',sans-serif;font-weight:600;font-size:11.5pt;color:var(--pine);margin:16pt 0 6pt;page-break-after:avoid;}
p{margin:0 0 9pt;}
strong{font-weight:600;color:var(--ink);}
a{color:var(--pine-700);text-decoration:none;}
hr{border:none;border-top:1px solid var(--hairline);margin:18pt 0;}
table{border-collapse:collapse;width:100%;font-size:8.6pt;line-height:1.45;margin:10pt 0 14pt;}
th{font-family:'JetBrains Mono',monospace;font-size:7.6pt;text-transform:uppercase;letter-spacing:0.08em;text-align:left;color:var(--muted);border-bottom:1.5px solid var(--pine);padding:5pt 7pt;}
td{border-bottom:1px solid var(--hairline);padding:6pt 7pt;vertical-align:top;}
td:first-child{font-family:'JetBrains Mono',monospace;font-size:8pt;white-space:nowrap;color:var(--pine);font-weight:400;}
tr{page-break-inside:avoid;}
ul,ol{margin:0 0 9pt;padding-left:18pt;}
li{margin-bottom:4pt;}
pre{background:var(--surface);border:1px solid var(--hairline);border-radius:4pt;padding:10pt 12pt;font-family:'JetBrains Mono',monospace;font-size:8.2pt;line-height:1.5;overflow:hidden;page-break-inside:avoid;}
code{font-family:'JetBrains Mono',monospace;font-size:0.92em;}
blockquote{border-left:2.5px solid var(--pine);margin:10pt 0;padding:2pt 0 2pt 12pt;color:var(--muted);}
em{color:inherit;}
h2+p>strong:first-child{color:var(--pine);}
/* cover block: first three elements */
body>h1:first-child{margin-top:34pt;font-size:34pt;}
p:has(strong):first-of-type{}
/* references list compact */
ol li{font-size:9pt;line-height:1.5;}
/* footer fine print */
body>p:nth-last-of-type(-n+2) em{font-size:8pt;color:var(--muted);line-height:1.5;}
</style></head><body>
${body}
</body></html>`

writeFileSync('whitepaper.html', html)
console.log('whitepaper.html written:', html.length, 'bytes')

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
execSync(
  `"${chrome}" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="${process.cwd()}\\ClaimFlow-Whitepaper-Attribution-in-Curved-Space.pdf" "file:///${process.cwd().replace(/\\/g, '/')}/whitepaper.html"`,
  { stdio: 'inherit', timeout: 120000 },
)
console.log('PDF written')
