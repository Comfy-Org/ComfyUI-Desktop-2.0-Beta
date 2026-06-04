/**
 * Sign-in "copy login link" card.
 *
 * When `handleFirebasePopup` opens the loopback login URL in the user's
 * DEFAULT browser, that browser may not be where they're signed into
 * Google/GitHub. We inject a small floating card into the embedded Cloud
 * view (the surface the user is looking at) offering "Copy link" / "Open
 * again" so they can finish sign-in in a browser of their choice — the
 * same affordance Notion / Claude / Zoom provide.
 *
 * Injected with `insertCSS` + `executeJavaScript`, like
 * `injectMacPasskeyWarning`. The URL is string-baked via `JSON.stringify`
 * so a hostile URL can't break the Cloud page. Copy stays in-page; only
 * "Open again" reaches main (see `OPEN_LINK_SENTINEL`).
 */

export const COPY_LINK_BANNER_ID = 'comfy-copy-login-banner'

/**
 * Open-again → main, so it can `shell.openExternal` (page JS can't). The
 * only page→main channel — copy stays in-page so a remote page can't
 * drive a no-gesture clipboard write — and it re-opens only our own URL.
 */
export const OPEN_LINK_SENTINEL = '__comfyOpenLoginLink'

export interface CopyLinkBannerLabels {
  message: string
  copy: string
  copied: string
  openAgain: string
  dismiss: string
}

export const COPY_LINK_BANNER_CSS =
  // Width hugs the content (so the message stays on one line) but is
  // capped at the viewport, so as the window shrinks the card grows
  // toward full-width instead of wrapping the text.
  `#${COPY_LINK_BANNER_ID}{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);` +
  `z-index:2147483647;display:flex;align-items:center;gap:10px;` +
  `width:max-content;max-width:calc(100vw - 32px);` +
  `background:#ffffff;color:#1f2937;font:13px/1.45 system-ui,-apple-system,sans-serif;` +
  `padding:10px 12px;border:1px solid #e5e7eb;border-radius:12px;` +
  `box-shadow:0 8px 28px rgba(0,0,0,.18);box-sizing:border-box;}` +
  `#${COPY_LINK_BANNER_ID} .ccl-msg{flex:0 1 auto;min-width:0;white-space:nowrap;}` +
  `#${COPY_LINK_BANNER_ID} button{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;` +
  `cursor:pointer;border-radius:8px;font:13px/1 system-ui,sans-serif;padding:7px 12px;` +
  `border:1px solid #d1d5db;background:#f9fafb;color:#111827;}` +
  `#${COPY_LINK_BANNER_ID} .ccl-ico{display:inline-flex;align-items:center;}` +
  `#${COPY_LINK_BANNER_ID} button.ccl-primary{background:#111827;color:#fff;border-color:#111827;}` +
  `#${COPY_LINK_BANNER_ID} button.ccl-done{background:#16a34a;border-color:#16a34a;}` +
  `#${COPY_LINK_BANNER_ID} button.ccl-close{border:none;background:transparent;color:#6b7280;` +
  `padding:4px 6px;font-size:16px;line-height:1;}`

/**
 * Build the page-context IIFE that renders the card. Every interpolated
 * value (the URL and each label) is escaped via `JSON.stringify`, so the
 * script is safe to hand to `executeJavaScript` even for hostile input.
 */
export function buildCopyLinkBannerScript(url: string, labels: CopyLinkBannerLabels): string {
  const u = JSON.stringify(url)
  const id = JSON.stringify(COPY_LINK_BANNER_ID)
  const openToken = JSON.stringify(OPEN_LINK_SENTINEL)
  const l = {
    message: JSON.stringify(labels.message),
    copy: JSON.stringify(labels.copy),
    copied: JSON.stringify(labels.copied),
    openAgain: JSON.stringify(labels.openAgain),
    dismiss: JSON.stringify(labels.dismiss),
  }
  return `(function(){try{
    var URL=${u}, ID=${id};
    var existing=document.getElementById(ID);
    if(existing){existing.__cclUrl=URL;return;}
    var bar=document.createElement('div');bar.id=ID;bar.__cclUrl=URL;
    // Lucide icons (copy / check / external-link), inlined as exact path
    // data — no asset/font load, identical on every OS. Static trusted
    // constants, set via innerHTML; user labels stay in textContent spans.
    function svg(p){return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+p+'</svg>';}
    var ICON_COPY=svg('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>');
    var ICON_TICK=svg('<path d="M20 6 9 17l-5-5"/>');
    var ICON_OPEN=svg('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>');
    function makeBtn(cls,icon,text){
      var b=document.createElement('button');if(cls)b.className=cls;
      var i=document.createElement('span');i.className='ccl-ico';i.innerHTML=icon;
      var t=document.createElement('span');t.textContent=text;
      b.appendChild(i);b.appendChild(t);b.__ico=i;b.__lbl=t;return b;
    }
    var msg=document.createElement('span');msg.className='ccl-msg';msg.textContent=${l.message};
    var copy=makeBtn('ccl-primary',ICON_COPY,${l.copy});
    var open=makeBtn('',ICON_OPEN,${l.openAgain});
    var close=document.createElement('button');close.className='ccl-close';close.setAttribute('aria-label',${l.dismiss});close.textContent='\\u00d7';
    function fallbackCopy(text){try{var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);}catch(e){}}
    copy.addEventListener('click',function(){
      var text=bar.__cclUrl;
      var flash=function(){copy.__ico.innerHTML=ICON_TICK;copy.__lbl.textContent=${l.copied};copy.classList.add('ccl-done');setTimeout(function(){copy.__ico.innerHTML=ICON_COPY;copy.__lbl.textContent=${l.copy};copy.classList.remove('ccl-done');},1500);};
      if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(flash,function(){fallbackCopy(text);flash();});}
      else{fallbackCopy(text);flash();}
    });
    open.addEventListener('click',function(){try{console.info(${openToken});}catch(e){}});
    close.addEventListener('click',function(){try{if(bar.__cclObs)bar.__cclObs.disconnect();bar.remove();}catch(e){}});
    bar.appendChild(msg);bar.appendChild(copy);bar.appendChild(open);bar.appendChild(close);
    document.body.appendChild(bar);
    var obs=new MutationObserver(function(){if(!document.getElementById(ID)&&bar.__cclUrl){document.body.appendChild(bar);}});
    obs.observe(document.body,{childList:true});bar.__cclObs=obs;
  }catch(e){}})()`
}

/** Remove the card and detach its observer. Idempotent. */
export function buildRemoveCopyLinkBannerScript(): string {
  const id = JSON.stringify(COPY_LINK_BANNER_ID)
  return `(function(){try{var b=document.getElementById(${id});if(b){if(b.__cclObs)b.__cclObs.disconnect();b.remove();}}catch(e){}})()`
}
