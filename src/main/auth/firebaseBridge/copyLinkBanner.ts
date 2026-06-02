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
  `#${COPY_LINK_BANNER_ID}{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);` +
  `z-index:2147483647;display:flex;align-items:center;gap:10px;max-width:min(560px,calc(100vw - 32px));` +
  `background:#ffffff;color:#1f2937;font:13px/1.45 system-ui,-apple-system,sans-serif;` +
  `padding:10px 12px;border:1px solid #e5e7eb;border-radius:12px;` +
  `box-shadow:0 8px 28px rgba(0,0,0,.18);box-sizing:border-box;}` +
  `#${COPY_LINK_BANNER_ID} .ccl-msg{flex:1 1 auto;}` +
  `#${COPY_LINK_BANNER_ID} button{flex:0 0 auto;cursor:pointer;border-radius:8px;` +
  `font:13px/1 system-ui,sans-serif;padding:7px 12px;border:1px solid #d1d5db;background:#f9fafb;color:#111827;}` +
  `#${COPY_LINK_BANNER_ID} button.ccl-primary{background:#111827;color:#fff;border-color:#111827;}` +
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
    var msg=document.createElement('span');msg.className='ccl-msg';msg.textContent=${l.message};
    var copy=document.createElement('button');copy.className='ccl-primary';copy.textContent=${l.copy};
    var open=document.createElement('button');open.textContent=${l.openAgain};
    var close=document.createElement('button');close.className='ccl-close';close.setAttribute('aria-label',${l.dismiss});close.textContent='\\u00d7';
    function fallbackCopy(text){try{var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);}catch(e){}}
    copy.addEventListener('click',function(){
      var text=bar.__cclUrl;
      var flash=function(){copy.textContent=${l.copied};setTimeout(function(){copy.textContent=${l.copy};},1500);};
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
