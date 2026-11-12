import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import React from 'react';
import {build} from 'esbuild';
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../',import.meta.url));
for(const file of ['yuban-original.jsx','語伴20260713.1-codex.js']){
    const source=readFileSync(new URL('../'+file,import.meta.url),'utf8');
    const compiled=await build({stdin:{contents:source+'\nexport {SubtitleReviewWord};',loader:'jsx',resolveDir:root},bundle:true,platform:'node',format:'cjs',external:['react'],write:false,logLevel:'silent'});
    test('review hints contain no answer until clicked and can be masked again: '+file,()=>{
        let revealed=false;
        const runtime={...React,useState:()=>[revealed,value=>{revealed=typeof value==='function'?value(revealed):value;} ]};
        const module={exports:{}};
        vm.runInNewContext(compiled.outputFiles[0].text,{module,exports:module.exports,require:name=>name==='react'?runtime:require(name),console});
        const render=()=>module.exports.SubtitleReviewWord({word:{accepted:['ghosted','ghost dude']},number:1});
        let node=render();assert.equal(node.props.children,'••••');assert.ok(!JSON.stringify(node).includes('ghost'));
        assert.equal(node.props['aria-label'],'顯示第 1 個複習字');node.props.onClick();node=render();
        assert.equal(node.props.children,'ghosted／ghost dude');node.props.onClick();assert.equal(render().props.children,'••••');
    });
}
