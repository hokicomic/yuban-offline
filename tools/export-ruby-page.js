/* Run in the browser console on a page you have already opened normally.
 * Select the article body first to exclude navigation, or select nothing to
 * locate the main/article element containing ruby annotations. No site storage,
 * account data, cookies or hidden framework state is read or exported. */
(() => {
 const selection=window.getSelection();
 let fragment;
 if(selection?.rangeCount && !selection.isCollapsed)fragment=selection.getRangeAt(0).cloneContents();
 else {
  const candidates=[...document.querySelectorAll('article,main,[role="main"]')].filter(element=>element.querySelector('ruby'));
  candidates.sort((a,b)=>b.querySelectorAll('ruby').length-a.querySelectorAll('ruby').length);
  const body=document.querySelector('#js-article-body') || candidates[0];
  if(!body)throw Error('未找到含 ruby 的文章。請先正常開啟完整文章，選取正文後再匯出；若停在登入或使用條款頁，請由使用者自行處理。');
  fragment=body.cloneNode(true);
 }
 const holder=document.createElement('div');holder.append(fragment);
 holder.querySelectorAll('script,style,nav,header,footer,button,form,iframe').forEach(node=>node.remove());
 if(!holder.querySelector('ruby rt'))throw Error('選取內容沒有振假名；請包含原字與上方讀音，不要只複製純文字。');
 const textNode=node=>{
  if(node.nodeType===Node.TEXT_NODE)return node.nodeValue;
  if(node.nodeType!==Node.ELEMENT_NODE)return [...node.childNodes].map(textNode).join('');
  const tag=node.tagName.toLowerCase();
  if(tag==='rt'||tag==='rp')return '';
  if(tag==='ruby'){
   const reading=[...node.querySelectorAll('rt')].map(item=>item.textContent.trim()).join('');
   const clone=node.cloneNode(true);clone.querySelectorAll('rt,rp').forEach(item=>item.remove());
   const base=clone.textContent;
   return reading?`｜${base}《${reading}》`:base;
  }
  if(tag==='br')return '\n';
  const text=[...node.childNodes].map(textNode).join('');
  return /^(?:p|div|section|article|main|h[1-6])$/.test(tag)?text+'\n':text;
 };
 const annotated=textNode(holder).replace(/\n{3,}/g,'\n\n').trim();
 const media=[];
 const collect=(doc,depth)=>{
  for(const element of doc.querySelectorAll('audio,video,audio source,video source'))for(const value of [element.currentSrc,element.src,element.getAttribute('src')])if(value)media.push(new URL(value,doc.URL).href);
  if(depth<2)for(const frame of doc.querySelectorAll('iframe')){try{if(frame.contentDocument)collect(frame.contentDocument,depth+1);}catch(_){}}
 };
 collect(document,0);
 const mediaUrls=[...new Set(media)].filter(url=>/^https:\/\//.test(url) && (!location.pathname.startsWith('/news/easy/') || url.includes('/news/easy_audio/')));
 const manifest={schemaVersion:1,sourceUrl:location.href,title:document.title,exportedAt:new Date().toISOString(),mediaUrls,note:'音訊網址可能限時有效；串流需由下載程式處理。未包含登入資訊或 Cookie。'};
 const name=location.pathname.split('/').filter(Boolean).at(-1)?.replace(/\.[^.]+$/,'') || 'article';
 const download=(suffix,content,type)=>{
  const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name+suffix;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
 };
 download('.ruby.txt',annotated,'text/plain;charset=utf-8');
 download('.media.json',JSON.stringify(manifest,null,2),'application/json;charset=utf-8');
 console.info(`已匯出 ${holder.querySelectorAll('ruby').length} 處原文讀音及 ${manifest.mediaUrls.length} 個公開媒體網址。請將 .ruby.txt 與音檔、LRC 放在同一資料夾。`);
})();
