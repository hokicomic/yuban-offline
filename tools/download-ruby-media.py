#!/usr/bin/env python3
"""Downloader integration entry point for export-ruby-page.js .media.json.
Reads no browser profile/cookies, does not handle DRM or acceptance gates.
Call download_manifest(manifest_path, out_dir) from an existing downloader.
"""
import argparse
import json
from pathlib import Path
import subprocess
from urllib.parse import urlparse
from urllib.request import Request, urlopen


def download_manifest(manifest_path, out_dir, index=0):
    manifest_path=Path(manifest_path)
    data=json.loads(manifest_path.read_text(encoding='utf-8'))
    urls=data.get('mediaUrls', [])
    if not isinstance(urls,list) or not urls:
        raise ValueError('匯出檔沒有可下載媒體網址；請先在文章中載入音訊後重新匯出。')
    url=urls[index]
    if urlparse(url).scheme!='https':
        raise ValueError('只接受正常網頁公開的 HTTPS 媒體網址；blob 需由原下載程式擷取，不繞過登入或 DRM。')
    stem=manifest_path.name.removesuffix('.media.json')
    out=Path(out_dir);out.mkdir(parents=True,exist_ok=True)
    annotated=manifest_path.with_name(stem+'.ruby.txt')
    if not annotated.is_file():
        raise ValueError('缺少同名 .ruby.txt，無法保存原文讀音。')
    text=annotated.read_text(encoding='utf-8')
    if not text.strip():
        raise ValueError('讀音文本為空。')
    audio=out/(stem+'.m4a')
    if audio.exists() or (out/(stem+'.ruby.txt')).exists():
        raise FileExistsError('輸出已有同名音訊或文本，請另選資料夾，避免覆寫。')
    # Inspect response type before invoking ffmpeg; an expired/gated HTML page
    # must never be saved as audio or reported as a successful download.
    with urlopen(Request(url,headers={'User-Agent':'Yuban local article downloader'}),timeout=30) as response:
        kind=response.headers.get_content_type()
        if kind in ('text/html','application/xhtml+xml'):
            raise ValueError('媒體網址回傳網頁，可能已過期或需要授權，未下載。')
    subprocess.run(['ffmpeg','-nostdin','-n','-i',url,'-vn','-c:a','aac',str(audio)],check=True)
    (out/(stem+'.ruby.txt')).write_text(text,encoding='utf-8')
    (out/(stem+'.media.json')).write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    return audio

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest');parser.add_argument('--out',required=True);parser.add_argument('--index',type=int,default=0)
    args=parser.parse_args()
    print(download_manifest(args.manifest,args.out,args.index))
