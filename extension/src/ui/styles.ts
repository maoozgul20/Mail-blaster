export const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.mb { font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #e5e7eb; }
.panel { animation: panel-in .32s cubic-bezier(.2,.85,.25,1) both; position: fixed; right: 16px; top: 64px; width: 392px; max-width: calc(100vw - 32px); max-height: calc(100vh - 88px); display: flex; flex-direction: column;
  background: linear-gradient(180deg,#10162c,#0c1124); border: 1px solid #2f3a66; border-radius: 14px; box-shadow: 0 24px 70px rgba(10,10,40,.65), 0 0 0 1px rgba(124,58,237,.18); z-index: 2147483000; overflow: hidden; }
.hdr { display: flex; align-items: center; gap: 8px; padding: 11px 12px; background: linear-gradient(120deg,#3b3ccf,#7c3aed,#c026d3,#3b3ccf); background-size: 240% 100%; animation: pan 9s ease infinite; color: #fff; font-weight: 600; letter-spacing: .01em; }
.hdr .sp { flex: 1; }
.pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: rgba(16,185,129,.25); color: #6ee7b7; border: 1px solid rgba(16,185,129,.5); font-weight: 600; }
.pill.warn { background: rgba(245,158,11,.2); color: #fcd34d; border-color: rgba(245,158,11,.5); }
.pill.err { background: rgba(244,63,94,.2); color: #fda4af; border-color: rgba(244,63,94,.5); }
.x { background: none; border: 0; color: #fff; cursor: pointer; font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 6px; }
.x:hover { background: rgba(255,255,255,.15); }
.body { overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.sec { border: 1px solid #263055; border-radius: 11px; background: #141b34; transition: border-color .2s, box-shadow .2s; }
.sec:hover { border-color: #3b4a85; }
.sec[open] { box-shadow: 0 6px 22px rgba(79,70,229,.14); }
.sec > summary { cursor: pointer; list-style: none; padding: 9px 12px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.sec > summary::-webkit-details-marker { display: none; }
.sec > summary::before { content: '▸'; color: #8b93ad; transition: transform .15s; }
.sec[open] > summary::before { transform: rotate(90deg); }
.sec .chip { margin-left: auto; font-weight: 500; font-size: 11px; color: #a5b4fc; background: #1e2447; padding: 1px 8px; border-radius: 999px; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sec .in { padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 8px; }
.sec[open] > .in { animation: reveal .28s cubic-bezier(.2,.8,.2,1) both; }
label { display: block; font-size: 12px; color: #a8b0c6; margin-bottom: 3px; }
input[type=text], input[type=email], input[type=password], input[type=number], input[type=url], input[type=datetime-local], input[type=time], select, textarea {
  width: 100%; background: #0b1020; color: #e5e7eb; border: 1px solid #2a3350; border-radius: 7px; padding: 6px 8px; font: inherit; }
textarea { min-height: 70px; resize: vertical; }
input:focus, select:focus, textarea:focus, button:focus-visible { outline: 2px solid #6366f1; outline-offset: 1px; }
.row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.row > * { flex: 0 0 auto; }
.row > .grow { flex: 1 1 0; min-width: 0; }
.btn { transition: transform .15s, background .15s, filter .15s, box-shadow .15s; cursor: pointer; border: 1px solid #2a3350; background: #1b2240; color: #e5e7eb; border-radius: 7px; padding: 6px 10px; font: inherit; font-weight: 500; }
.btn:hover { background: #2a3364; transform: translateY(-1px); }
.btn:active { transform: translateY(0) scale(.98); }
.btn.primary { background: linear-gradient(120deg,#4f46e5,#7c3aed,#c026d3,#4f46e5); background-size: 220% 100%; animation: pan 8s ease infinite; box-shadow: 0 6px 18px rgba(99,60,230,.4); border: 0; color: #fff; font-weight: 600; padding: 8px 14px; }
.btn.primary:hover { filter: brightness(1.12); box-shadow: 0 10px 26px rgba(124,58,237,.5); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.sm { padding: 3px 8px; font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.c { transition: all .16s; cursor: pointer; border: 1px solid #2a3350; background: transparent; color: #a8b0c6; border-radius: 999px; padding: 2px 9px; font-size: 12px; }
.c:hover { background: #222b57; color: #fff; transform: translateY(-1px); }
.c.on { background: linear-gradient(135deg,#4338ca,#7c3aed); border-color: #8b5cf6; color: #fff; animation: pop .22s cubic-bezier(.2,.9,.3,1.3); }
.muted { color: #8b93ad; font-size: 12px; }
.ok { color: #6ee7b7; } .bad { color: #fda4af; } .warn { color: #fcd34d; }
.badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: #1e2447; color: #c7d2fe; }
.badge.g { background: rgba(16,185,129,.18); color: #6ee7b7; } .badge.r { background: rgba(244,63,94,.18); color: #fda4af; } .badge.a { background: rgba(245,158,11,.18); color: #fcd34d; }
.foot { padding: 10px; border-top: 1px solid #232b45; display: flex; gap: 8px; background: #0f1426; flex-wrap: wrap; }
.foot .primary { flex: 1; }
.msg { animation: reveal .25s ease both; border-radius: 8px; padding: 8px 10px; font-size: 12px; }
.msg.e { background: rgba(244,63,94,.12); border: 1px solid rgba(244,63,94,.4); color: #fecdd3; }
.msg.s { background: rgba(16,185,129,.12); border: 1px solid rgba(16,185,129,.4); color: #a7f3d0; }
.msg.i { background: rgba(99,102,241,.12); border: 1px solid rgba(99,102,241,.4); color: #c7d2fe; }
.launch { transition: transform .18s, filter .18s, box-shadow .18s; box-shadow: 0 4px 14px rgba(99,60,230,.45); display: inline-flex; align-items: center; gap: 6px; height: 36px; margin-left: 8px; padding: 0 14px; border: 0; border-radius: 18px; cursor: pointer;
  background: linear-gradient(135deg,#4f46e5,#7c3aed); color: #fff; font: 600 13px system-ui, sans-serif; }
.launch:hover { filter: brightness(1.15); transform: translateY(-1px) scale(1.03); box-shadow: 0 8px 22px rgba(124,58,237,.55); }
.frame { width: 100%; height: 150px; border: 1px solid #2a3350; border-radius: 7px; background: #fff; }
.stage { border: 1px solid #232b45; border-radius: 8px; padding: 8px; background: #101528; }
table { width: 100%; border-collapse: collapse; font-size: 12px; } td, th { padding: 3px 4px; text-align: left; border-bottom: 1px solid #232b45; }
.pill-global { animation: pop .4s cubic-bezier(.2,.9,.3,1.2) both; transition: transform .18s, border-color .18s; position: fixed; left: 16px; bottom: 16px; z-index: 2147482000; display: flex; align-items: center; gap: 8px; padding: 7px 12px; background: #0f1426; border: 1px solid #2a3350; border-radius: 999px; color: #e5e7eb; font: 600 12px system-ui, sans-serif; cursor: pointer; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #34d399; color: #34d399; animation: ring 2s ease-out infinite; } .dot.off { background: #f59e0b; }
.menu { animation: pop .2s cubic-bezier(.2,.9,.3,1.2) both; position: fixed; left: 16px; bottom: 58px; z-index: 2147482000; background: #0f1426; border: 1px solid #2a3350; border-radius: 10px; padding: 6px; min-width: 210px; box-shadow: 0 12px 36px rgba(0,0,0,.5); }
.menu button { display: block; width: 100%; text-align: left; background: none; border: 0; color: #e5e7eb; padding: 7px 10px; border-radius: 6px; font: 500 13px system-ui, sans-serif; cursor: pointer; }
.menu button { transition: background .15s, transform .15s; }
.menu button:hover { background: #232b57; transform: translateX(2px); }

.link { background: none; border: 0; color: #a5b4fc; cursor: pointer; font: inherit; padding: 2px; text-align: center; transition: color .15s; }
.link:hover { color: #fff; text-decoration: underline; }
.form { animation: reveal .3s ease both; }
.pill-global:hover { transform: translateY(-2px); border-color: #6366f1; }
@keyframes panel-in { from { opacity: 0; transform: translateX(24px) scale(.97); } to { opacity: 1; transform: none; } }
@keyframes reveal { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: none; } }
@keyframes pop { from { opacity: 0; transform: scale(.9); } to { opacity: 1; transform: none; } }
@keyframes pan { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
@keyframes ring { 0% { box-shadow: 0 0 0 0 rgba(52,211,153,.7); } 70% { box-shadow: 0 0 0 7px rgba(52,211,153,0); } 100% { box-shadow: 0 0 0 0 rgba(52,211,153,0); } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; } }
`;
