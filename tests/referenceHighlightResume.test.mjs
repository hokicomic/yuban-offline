import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

for (const file of ['yuban-original.jsx','語伴20260713.1-codex.js']) {
    const source=readFileSync(new URL('../'+file,import.meta.url),'utf8');
    const helper=source.slice(source.indexOf('const installKnowledgeActiveLineFollow ='),source.indexOf('const canCollapseBlankReferencePanel ='));
    const follow=vm.runInNewContext(helper+'\ninstallKnowledgeActiveLineFollow;');
    const viewport=()=>{
        const frames=new Map(),observers=[],scrolls=[],queries=[];
        let id=0;
        const win={requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id),
            ResizeObserver:class {constructor(fn){this.fn=fn;observers.push(this);}observe(node){this.node=node;}disconnect(){this.disconnected=true;}}};
        const container={ownerDocument:{defaultView:win},clientHeight:0,scrollHeight:3000,scrollTop:0,
            getBoundingClientRect(){return {top:40,height:this.clientHeight};},
            querySelector(selector){queries.push(selector);return {getBoundingClientRect:()=>({top:40}),
                querySelector:()=>({getBoundingClientRect:()=>({top:1240-container.scrollTop})})};},
            scrollTo(value){scrolls.push(value);this.scrollTop=value.top;}};
        const paint=()=>{while(frames.size){const batch=[...frames.values()];frames.clear();batch.forEach(fn=>fn());}};
        return {container,frames,observers,scrolls,queries,paint};
    };
    test('several cues advance while collapsed; reopening and resizing reveal the latest mark, never the old paragraph: '+file,()=>{
        const page=viewport();
        let cleanup=follow(page.container,10);page.paint();assert.equal(page.scrolls.length,0);
        for(const line of [11,12,13]){cleanup();cleanup=follow(page.container,line);page.paint();}
        page.container.clientHeight=120;page.observers.at(-1).fn();page.paint();
        assert.match(page.queries.at(-1),/="13"/);
        assert.equal(page.scrolls.at(-1).top,1200-28.8,'uses the mark inside a long paragraph');
        page.container.clientHeight=400;page.observers.at(-1).fn();page.paint();
        assert.equal(page.scrolls.at(-1).top,1104,'repositions after the expansion transition finishes');
        const count=page.scrolls.length;
        page.observers.at(-1).fn();cleanup();page.paint();
        assert.equal(page.scrolls.length,count);assert.equal(page.frames.size,0);
        assert.ok(page.observers.every(observer=>observer.disconnected));
    });
    test('missing marks use the current line; unavailable targets and viewports are harmless: '+file,()=>{
        const page=viewport();page.container.clientHeight=200;
        page.container.querySelector=()=>({querySelector:()=>null,getBoundingClientRect:()=>({top:240})});
        const cleanup=follow(page.container,0);page.paint();assert.equal(page.scrolls.at(-1).top,152);
        page.container.querySelector=()=>null;page.observers[0].fn();page.paint();assert.equal(page.scrolls.length,1);
        cleanup();assert.doesNotThrow(()=>follow(null,0)());
    });
    test('switching practice modes releases a frozen reading view without clearing selections outside the reference: '+file,()=>{
        const code=source.slice(source.lastIndexOf('    useEffect(() => {',source.indexOf('// Changing subtitle practice mode')),
            source.indexOf('    const resetKnowledgeReverseSelection ='));
        const viewCode=source.slice(source.indexOf('const getKnowledgeReverseReadingView ='),source.indexOf('const installKnowledgeReverseSelectionCapture ='));
        let effect,deps,removed=0;
        const state={isSubtitleBlankMode:true,selecting:true,selected:'old sentence',notice:'old result',
            window:{getSelection:()=>({rangeCount:1,getRangeAt:()=>({commonAncestorContainer:{}}),removeAllRanges:()=>removed++})},
            embeddedKnowledgeContentRef:{current:{contains:()=>true}},
            useEffect:(fn,d)=>{effect=fn;deps=d;},setKnowledgeReverseSelection:value=>state.selected=value,
            setKnowledgeReverseNotice:value=>state.notice=value,setKnowledgeReverseSelecting:value=>state.selecting=value};
        const context=vm.createContext(state);
        const view=vm.runInContext(viewCode+'\ngetKnowledgeReverseReadingView;',context);
        const old={content:'book',activeKnowledgeSubtitleText:'cue 1'},current={content:'book',activeKnowledgeSubtitleText:'cue 8'};
        assert.equal(view(current,old,state.selecting),old);
        vm.runInContext(code,context);assert.equal(deps[0],true);effect();
        assert.equal(state.selecting,false);assert.equal(state.selected,'');assert.equal(state.notice,'');assert.equal(removed,1);
        assert.equal(view(current,old,state.selecting),current,'the corrected cue and reading highlight resume together');
        context.isSubtitleBlankMode=false;state.selecting=true;state.embeddedKnowledgeContentRef.current.contains=()=>false;
        vm.runInContext(code,context);assert.equal(deps[0],false);effect();
        assert.equal(state.selecting,false);assert.equal(removed,1,'a caption copied outside the reference remains selected');
    });
    test('reopening on the same cue restarts following, while deliberate reference selection pauses it: '+file,()=>{
        const code=source.slice(source.lastIndexOf('    useEffect(() => {',source.indexOf('// Matching continues while the blank-mode')),
            source.indexOf('    const isLatinTermWordChar ='));
        let previous,cleanup,starts=0,stops=0;
        const state={knowledgeReverseSelecting:false,topPanelMode:'document',isVideoMasked:false,isSubtitleBlankMode:true,
            embeddedKnowledgePanelHeight:50,blankReferencePanelHeight:null,embeddedKnowledgeLoading:false,embeddedKnowledgeError:'',
            embeddedKnowledgeRenderIndex:8,embeddedKnowledgeSourceLines:[13],embeddedKnowledgeContentRef:{current:{}},
            installKnowledgeActiveLineFollow:(container,line)=>{assert.equal(line,13);starts++;return ()=>stops++;},
            useEffect:(fn,deps)=>{if(!previous || deps.some((value,index)=>value!==previous[index])){cleanup?.();cleanup=fn();previous=deps;}}};
        const context=vm.createContext(state),render=()=>vm.runInContext(code,context);
        render();assert.equal(starts,1);
        context.isSubtitleBlankMode=false;render();assert.equal(starts,2,'same cue must be revealed after reopening');
        context.knowledgeReverseSelecting=true;render();assert.equal(stops,2);assert.equal(starts,2);
        context.knowledgeReverseSelecting=false;render();assert.equal(starts,3);
        context.isVideoMasked=true;render();assert.equal(stops,3);
    });
}
