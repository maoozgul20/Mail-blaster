export const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.mb { font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #e5e7eb; }
.panel { position: fixed; right: 16px; top: 64px; width: 392px; max-width: calc(100vw - 32px); max-height: calc(100vh - 88px); display: flex; flex-direction: column;
  background: #0f1426; border: 1px solid #2a3350; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,.55); z-index: 2147483000; overflow: hidden; }
.hdr { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: linear-gradient(135deg,#3b3ccf,#7c3aed); color: #fff; font-weight: 600; }
.hdr .sp { flex: 1; }
.pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: rgba(16,185,129,.25); color: #6ee7b7; border: 1px solid rgba(16,185,129,.5); font-weight: 600; }
.pill.warn { background: rgba(245,158,11,.2); color: #fcd34d; border-color: rgba(245,158,11,.5); }
.pill.err { background: rgba(244,63,94,.2); color: #fda4af; border-color: rgba(244,63,94,.5); }
.x { background: none; border: 0; color: #fff; cursor: pointer; font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 6px; }
.x:hover { background: rgba(255,255,255,.15); }
.body { overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.sec { border: 1px solid #232b45; border-radius: 10px; background: #141a30; }
.sec > summary { cursor: pointer; list-style: none; padding: 9px 12px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.sec > summary::-webkit-details-marker { display: none; }
.sec > summary::before { content: '▸'; color: #8b93ad; transition: transform .15s; }
.sec[open] > summary::before { transform: rotate(90deg); }
.sec .chip { margin-left: auto; font-weight: 500; font-size: 11px; color: #a5b4fc; background: #1e2447; padding: 1px 8px; border-radius: 999px; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sec .in { padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 8px; }
label { display: block; font-size: 12px; color: #a8b0c6; margin-bottom: 3px; }
input[type=text], input[type=email], input[type=password], input[type=number], input[type=url], input[type=datetime-local], input[type=time], select, textarea {
  width: 100%; background: #0b1020; color: #e5e7eb; border: 1px solid #2a3350; border-radius: 7px; padding: 6px 8px; font: inherit; }
textarea { min-height: 70px; resize: vertical; }
input:focus, select:focus, textarea:focus, button:focus-visible { outline: 2px solid #6366f1; outline-offset: 1px; }
.row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.row > * { flex: 0 0 auto; }
.row > .grow { flex: 1 1 0; min-width: 0; }
.btn { cursor: pointer; border: 1px solid #2a3350; background: #1b2240; color: #e5e7eb; border-radius: 7px; padding: 6px 10px; font: inherit; font-weight: 500; }
.btn:hover { background: #232b52; }
.btn.primary { background: linear-gradient(135deg,#4f46e5,#7c3aed); border: 0; color: #fff; font-weight: 600; padding: 8px 14px; }
.btn.primary:hover { filter: brightness(1.1); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.sm { padding: 3px 8px; font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.c { cursor: pointer; border: 1px solid #2a3350; background: transparent; color: #a8b0c6; border-radius: 999px; padding: 2px 9px; font-size: 12px; }
.c:hover { background: #1b2240; }
.c.on { background: #312e81; border-color: #6366f1; color: #fff; }
.muted { color: #8b93ad; font-size: 12px; }
.ok { color: #6ee7b7; } .bad { color: #fda4af; } .warn { color: #fcd34d; }
.badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: #1e2447; color: #c7d2fe; }
.badge.g { background: rgba(16,185,129,.18); color: #6ee7b7; } .badge.r { background: rgba(244,63,94,.18); color: #fda4af; } .badge.a { background: rgba(245,158,11,.18); color: #fcd34d; }
.foot { padding: 10px; border-top: 1px solid #232b45; display: flex; gap: 8px; background: #0f1426; flex-wrap: wrap; }
.foot .primary { flex: 1; }
.msg { border-radius: 8px; padding: 8px 10px; font-size: 12px; }
.msg.e { background: rgba(244,63,94,.12); border: 1px solid rgba(244,63,94,.4); color: #fecdd3; }
.msg.s { background: rgba(16,185,129,.12); border: 1px solid rgba(16,185,129,.4); color: #a7f3d0; }
.msg.i { background: rgba(99,102,241,.12); border: 1px solid rgba(99,102,241,.4); color: #c7d2fe; }
.launch { display: inline-flex; align-items: center; gap: 6px; height: 36px; margin-left: 8px; padding: 0 14px; border: 0; border-radius: 18px; cursor: pointer;
  background: linear-gradient(135deg,#4f46e5,#7c3aed); color: #fff; font: 600 13px system-ui, sans-serif; }
.launch:hover { filter: brightness(1.12); }
.frame { width: 100%; height: 150px; border: 1px solid #2a3350; border-radius: 7px; background: #fff; }
.stage { border: 1px solid #232b45; border-radius: 8px; padding: 8px; background: #101528; }
table { width: 100%; border-collapse: collapse; font-size: 12px; } td, th { padding: 3px 4px; text-align: left; border-bottom: 1px solid #232b45; }
.pill-global { position: fixed; left: 16px; bottom: 16px; z-index: 2147482000; display: flex; align-items: center; gap: 8px; padding: 7px 12px; background: #0f1426; border: 1px solid #2a3350; border-radius: 999px; color: #e5e7eb; font: 600 12px system-ui, sans-serif; cursor: pointer; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #34d399; } .dot.off { background: #f59e0b; }
.menu { position: fixed; left: 16px; bottom: 58px; z-index: 2147482000; background: #0f1426; border: 1px solid #2a3350; border-radius: 10px; padding: 6px; min-width: 210px; box-shadow: 0 12px 36px rgba(0,0,0,.5); }
.menu button { display: block; width: 100%; text-align: left; background: none; border: 0; color: #e5e7eb; padding: 7px 10px; border-radius: 6px; font: 500 13px system-ui, sans-serif; cursor: pointer; }
.menu button:hover { background: #1b2240; }
`;
