// Reload only this article's normal audio iframe. The website obtains its own
// new signed link; no cookies, credentials or signing endpoints are accessed.
(() => {
 const here=new URL(location.href);
 if(here.protocol!=='https:' || !['news.web.nhk','www3.nhk.or.jp'].includes(here.hostname) || !/^\/news\/easy\/([A-Za-z0-9_-]+)\/\1\.html$/.test(here.pathname))return JSON.stringify({reloading:false,reason:'wrong_page'});
 const frame=document.querySelector('#js-audio-inner iframe');
 if(!frame)return JSON.stringify({reloading:false,reason:'audio_not_open'});
 const url=new URL(frame.src,location.href);
 if(url.origin!==here.origin || !url.pathname.startsWith('/news/easy/player/'))return JSON.stringify({reloading:false,reason:'wrong_player'});
 const findMedia=doc=>{
  if(!doc)return null;
  const own=doc.querySelector('audio,video');if(own)return own;
  for(const child of doc.querySelectorAll('iframe')){try{const found=child.contentDocument?.querySelector('audio,video');if(found)return found;}catch(_){}}
  return null;
 };
 let media=null;try{media=findMedia(frame.contentDocument);}catch(_){}
 const state={paused:media?media.paused:true,time:media && Number.isFinite(media.currentTime)?media.currentTime:0,volume:media?media.volume:1,muted:media?media.muted:false};
 frame.addEventListener('load',()=>{
  let tries=0;
  const timer=setInterval(()=>{
   let current=null;try{current=findMedia(frame.contentDocument);}catch(_){}
   if(current){
    current.muted=state.muted;current.volume=state.volume;
    if(state.paused)current.pause();
    if(current.readyState>=1){
     try{current.currentTime=state.time;}catch(_){}
     if(!state.paused){const started=current.play();if(started?.catch)started.catch(()=>{});}
     clearInterval(timer);return;
    }
   }
   if(++tries>=60)clearInterval(timer);
  },150);
 },{once:true});
 frame.src=frame.src;
 return JSON.stringify({reloading:true});
})()
