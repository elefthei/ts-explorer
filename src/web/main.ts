import mermaid from "mermaid";
import { basicSetup, EditorView } from "codemirror";
import { EditorSelection, EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import type { UmlEntitySource, UmlExternalUser, UmlLocalUser, UmlSourceLocation } from "../types.ts";
import {
  editorOffset,
  createRequestSequence,
  externalUserIdFromNodeId,
  formatUmlMethodReturnLabel,
  localUserIdFromNodeId,
  hasPassedDragThreshold,
  panViewport,
  resolveUmlSource,
  shouldStackDiagram,
  zoomViewportAt,
  type ViewportState,
} from "./diagram-interactions.ts";

type TreeNode={name:string;path:string;kind:"directory"|"file";children?:TreeNode[];editable?:boolean};
type Diagram={kind:"packages"|"uml";scopePath:string;version:number;status:"ready"|"error";dsl:string;dsls:string[];sources:UmlEntitySource[];externalUsers:UmlExternalUser[];localUsers:UmlLocalUser[];error?:string};
type FileResponse={path:string;content:string;hash:string;editable:boolean};
type WatchMessage={type:"changed";version:number;paths:string[];events:string[]}|{type:"watch-error";version:number;error:string};
const $=<T extends Element = HTMLInputElement>(selector:string)=>document.querySelector<T>(selector)!;
const state={tree:null as TreeNode|null,mode:"packages" as "packages"|"uml",activeView:"packages" as "packages"|"uml"|"editor",scope:"",version:0,file:null as FileResponse|null,view:null as EditorView|null,dirty:false,conflict:false,ws:null as WebSocket|null,retry:250,collapsedDirs:new Set<string>()};
const ZOOM_IN_FACTOR=1.25;
const ZOOM_OUT_FACTOR=1/ZOOM_IN_FACTOR;
const viewport:ViewportState&{apply():void;reset():void;zoomAt(factor:number,x:number,y:number):void}={scale:1,x:0,y:0,apply(){$("#svg-holder").style.transform=`translate(${this.x}px,${this.y}px) scale(${this.scale})`;},reset(){this.scale=1;this.x=0;this.y=0;this.apply();const stage=$("#diagram-stage");stage.scrollLeft=0;stage.scrollTop=0;},zoomAt(factor,x,y){zoomViewportAt(this,factor,x,y);this.apply();}};
const diagramRequests=createRequestSequence();
mermaid.initialize({startOnLoad:false,securityLevel:"strict",theme:"dark"});
async function api<T>(url:string,init?:RequestInit):Promise<T>{const response=await fetch(url,init);const body=await response.json() as T & {error?:string};if(!response.ok)throw new Error(body.error??`Request failed (${response.status})`);return body;}
function setStatus(text:string,error=false){const node=$("#status");node.textContent=text;node.classList.toggle("error",error);}
function showError(error:string|undefined){const panel=$("#error-panel");panel.textContent=error??"";panel.hidden=!error;}
function setDiagramLoading(loading:boolean):void{const panel=$("#diagram-loading");panel.hidden=!loading;const stage=$("#diagram-stage");stage.setAttribute("aria-busy",String(loading));stage.classList.toggle("loading",loading);if(loading)showError(undefined);}
function parseMethodName(text:string):string{const normalized=text.trim().replace(/^\\?[+\-#~]/,"");const parenthesis=normalized.indexOf("(");return (parenthesis===-1?normalized:normalized.slice(0,parenthesis)).trim();}
function sourceFromLink(link:Element):UmlSourceLocation|undefined{const data=(link as HTMLElement).dataset;const line=Number(data.sourceLine);const column=Number(data.sourceColumn);if(!data.sourcePath||!Number.isInteger(line)||!Number.isInteger(column))return undefined;return{path:data.sourcePath,line,column};}
function makeSourceLink(element:Element,location:UmlSourceLocation,label:string):void{element.classList.add("uml-source-link");element.setAttribute("role","link");element.setAttribute("tabindex","0");element.setAttribute("aria-label",`Open ${label} in editor`);const data=(element as HTMLElement).dataset;data.sourcePath=location.path;data.sourceLine=String(location.line);data.sourceColumn=String(location.column);}
function decorateUmlLocalUsers(root:Element,localUsers:readonly UmlLocalUser[]):void{const byId=new Map(localUsers.map((user)=>[user.nodeId,user]));for(const node of root.querySelectorAll<SVGGElement>("g.node")){const nodeId=localUserIdFromNodeId(node.id);if(!nodeId)continue;const local=byId.get(nodeId);if(!local)continue;const title=node.querySelector(".label-group .label, .classTitle");if(title)makeSourceLink(title,local,local.label);}}
function decorateUmlExternalUsers(root:Element,externalUsers:readonly UmlExternalUser[]):void{const byId=new Map(externalUsers.map((user)=>[user.nodeId,user]));for(const node of root.querySelectorAll<SVGGElement>("g.node")){const nodeId=externalUserIdFromNodeId(node.id);if(!nodeId)continue;const external=byId.get(nodeId);if(!external)continue;const title=node.querySelector(".label-group .label, .classTitle");if(!title)continue;title.classList.add("uml-external-link");title.setAttribute("role","link");title.setAttribute("tabindex","0");title.setAttribute("aria-label","Open external user UML");(title as HTMLElement).dataset.scopePath=external.scopePath;}}
function decorateUmlSources(root:Element,sources:readonly UmlEntitySource[]):void{for(const node of root.querySelectorAll<SVGGElement>("g.node")){const match=/classId-(.+)-\d+$/.exec(node.id);if(!match)continue;const entityName=match[1];const entityLocation=resolveUmlSource(sources,entityName);if(!entityLocation)continue;const title=node.querySelector(".label-group .label, .classTitle");if(title)makeSourceLink(title,entityLocation,entityName);const occurrences=new Map<string,number>();for(const label of node.querySelectorAll(".methods-group > .label")){const formattedReturn=formatUmlMethodReturnLabel(label.textContent??"");if(formattedReturn!==undefined){const content=label.querySelector(".nodeLabel p, .nodeLabel")??label;content.textContent=formattedReturn;continue;}const methodName=parseMethodName(label.textContent??"");if(!methodName)continue;const occurrence=occurrences.get(methodName)??0;occurrences.set(methodName,occurrence+1);const methodLocation=resolveUmlSource(sources,entityName,methodName,occurrence);if(methodLocation)makeSourceLink(label,methodLocation,`${entityName}.${methodName}`);}}}
function renderTree(){const root=$("#tree");root.replaceChildren();if(!state.tree)return;const filter=$("#tree-filter").value.toLowerCase();const draw=(node:TreeNode):HTMLElement|null=>{const matching=!filter||node.name.toLowerCase().includes(filter)||node.path.toLowerCase().includes(filter);const children=(node.children??[]).map(draw).filter((x):x is HTMLElement=>x!==null);if(!matching&&!children.length)return null;const isDir=node.kind==="directory";const expanded=isDir&&!state.collapsedDirs.has(node.path);const wrap=document.createElement("div");const button=document.createElement("button");button.className=`tree-row ${state.scope===node.path&&state.mode===(node.kind==="file"?state.mode:"uml")?"selected":""}`;button.innerHTML=`<span class="icon">${isDir?(expanded?"▾":"▸"):"·"}</span><span>${node.name}</span>`;if(isDir)button.setAttribute("aria-expanded",String(expanded));button.onclick=()=>{if(isDir){if(state.collapsedDirs.has(node.path))state.collapsedDirs.delete(node.path);else state.collapsedDirs.add(node.path);void selectScope(node);}else void openFile(node.path);};wrap.append(button);if(children.length&&(expanded||filter)){const nested=document.createElement("div");nested.className="tree-children";children.forEach((child)=>nested.append(child));wrap.append(nested);}return wrap;};const result=draw(state.tree);if(result)root.append(result);}
async function loadTree(){const response=await api<{version:number;root:TreeNode}>("/api/tree");state.tree=response.root;state.version=response.version;$("#source-label").textContent=response.root.name;renderTree();}
async function loadDiagram(){
  const token=diagramRequests.next();
  const loading=state.mode==="uml";
  setDiagramLoading(loading);
  try{
    const query=new URLSearchParams({kind:state.mode,path:state.scope});
    const diagram=await api<Diagram>(`/api/diagram?${query}`);
    if(!diagramRequests.isCurrent(token))return;
    state.version=diagram.version;
    $("#dsl-content").textContent=diagram.dsl;
    showError(diagram.status==="error"?diagram.error:undefined);
    const holder=$("#svg-holder");
    if(shouldStackDiagram(state.mode)){
      holder.innerHTML="";
      holder.classList.add("stacked");
      holder.setAttribute("role","list");
      const errors:string[]=[];
      for(const [index,dsl] of diagram.dsls.entries()){
        const frame=document.createElement("div");
        frame.className="uml-frame";
        frame.setAttribute("role","listitem");
        frame.setAttribute("aria-label",`UML diagram ${index+1}`);
        frame.dataset.index=String(index);
        try{
          const rendered=await mermaid.render(`diagram-${token}-${index}`,dsl);
          if(!diagramRequests.isCurrent(token))return;
          frame.innerHTML=rendered.svg;
          decorateUmlSources(frame,diagram.sources);
          decorateUmlExternalUsers(frame,diagram.externalUsers);
          decorateUmlLocalUsers(frame,diagram.localUsers);
        }catch(error){
          if(!diagramRequests.isCurrent(token))return;
          const message=error instanceof Error?error.message:String(error);
          frame.classList.add("error");
          frame.textContent=`Diagram ${index+1}: ${message}`;
          errors.push(`Diagram ${index+1}: ${message}`);
        }
        holder.append(frame);
      }
      viewport.apply();
      if(errors.length){
        showError(errors.join("\n"));
        setStatus("Mermaid render error",true);
      }else setStatus(diagram.status==="error"?"Diagram parse error":`Updated · v${diagram.version}`,diagram.status==="error");
      return;
    }
    holder.classList.remove("stacked");
    holder.removeAttribute("role");
    try{
      const rendered=await mermaid.render(`diagram-${token}`,diagram.dsl);
      if(!diagramRequests.isCurrent(token))return;
      holder.innerHTML=rendered.svg;
      decorateUmlSources(holder,diagram.sources);
      decorateUmlExternalUsers(holder,diagram.externalUsers);
      decorateUmlLocalUsers(holder,diagram.localUsers);
      viewport.apply();
      setStatus(diagram.status==="error"?"Diagram parse error":`Updated · v${diagram.version}`,diagram.status==="error");
    }catch(error){
      if(!diagramRequests.isCurrent(token))return;
      showError(error instanceof Error?error.message:String(error));
      setStatus("Mermaid render error",true);
    }
  }catch(error){
    if(!diagramRequests.isCurrent(token))return;
    throw error;
  }finally{
    if(diagramRequests.isCurrent(token))setDiagramLoading(false);
  }
}
function activateView(view:"packages"|"uml"|"editor"){state.activeView=view;const activeButtonId=view==="editor"?"editor-mode":`${state.mode}-mode`;document.querySelectorAll(".mode").forEach((button)=>button.classList.toggle("active",button.id===activeButtonId));const editorActive=view==="editor";$("#graph-panel").hidden=editorActive;$("#editor-panel").hidden=!editorActive;const hasFile=state.file!==null;$("#editor-empty").hidden=hasFile;$("#editor-content").hidden=!hasFile;}
async function selectScope(node:TreeNode){state.mode=node.path===""||node.name==="packages"?"packages":"uml";state.scope=node.path;activateView(state.mode);viewport.reset();renderTree();try{await loadDiagram();}catch(error){showError(error instanceof Error?error.message:String(error));setStatus("Request failed",true);}}
function destroyEditor(){state.view?.destroy();state.view=null;state.file=null;state.dirty=false;state.conflict=false;$("#conflict").hidden=true;$("#editor-content").hidden=true;$("#editor-empty").hidden=false;}
function revealEditorLocation(location:UmlSourceLocation):void{if(!state.view)return;const offset=editorOffset(state.view.state.doc,location);state.view.dispatch({selection:EditorSelection.cursor(offset),effects:EditorView.scrollIntoView(offset,{y:"center"})});state.view.focus();}
async function openSource(location:UmlSourceLocation):Promise<void>{if(state.file?.path===location.path&&state.view){activateView("editor");revealEditorLocation(location);return;}await openFile(location.path,location);}
async function openFile(path:string,position?:UmlSourceLocation){
  try{
    const file=await api<FileResponse>(`/api/file?path=${encodeURIComponent(path)}`);
    destroyEditor();
    state.file=file;
    $("#editor-name").textContent=path.split("/").at(-1)??path;
    $("#editor-path").textContent=path;
    const extensions=[basicSetup,javascript({typescript:true,jsx:path.endsWith(".tsx")}),oneDark,keymap.of([{key:"Mod-s",run:()=>{void saveFile();return true;}}]),EditorView.updateListener.of((update)=>{if(update.docChanged){state.dirty=true;}})];
    if(!file.editable)extensions.push(EditorState.readOnly.of(true),EditorView.editable.of(false));
    state.view=new EditorView({state:EditorState.create({doc:file.content,extensions}),parent:$("#editor")});
    activateView("editor");
    if(position)revealEditorLocation(position);
    setStatus(file.editable?"Editing source":"Read-only file");
  }catch(error){
    setStatus(error instanceof Error?error.message:String(error),true);
  }
}
async function formatFile(){if(!state.file||!state.view)return;try{const response=await api<{path:string;content:string}>("/api/file/format",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:state.file.path,content:state.view.state.doc.toString()})});state.view.dispatch({changes:{from:0,to:state.view.state.doc.length,insert:response.content}});setStatus("Formatted in memory");}catch(error){setStatus(error instanceof Error?error.message:String(error),true);}}
async function saveFile(){if(!state.file?.editable||!state.view)return;try{const saved=await api<FileResponse>("/api/file",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({path:state.file.path,content:state.view.state.doc.toString(),baseHash:state.file.hash})});state.file=saved;state.dirty=false;state.conflict=false;$("#conflict").hidden=true;setStatus("Saved to disk");}catch(error){setStatus(error instanceof Error?error.message:String(error),true);}}
async function reloadOpenFile(){if(!state.file)return;const path=state.file.path;const wasDirty=state.dirty;destroyEditor();await openFile(path);if(wasDirty)setStatus("Reloaded disk version");}
function handleWatch(message:WatchMessage){if(message.type==="watch-error"){setStatus(message.error,true);return;}state.version=message.version;const openPath=state.file?.path;if(openPath&&message.paths.includes(openPath)&&state.dirty){state.conflict=true;$("#conflict").hidden=false;}else if(openPath&&message.paths.includes(openPath)){void reloadOpenFile();}void loadTree();void loadDiagram();setStatus(`Source changed · v${message.version}`);}
function connect(){const protocol=location.protocol==="https:"?"wss":"ws";const ws=new WebSocket(`${protocol}://${location.host}/ws`);state.ws=ws;ws.onopen=()=>{state.retry=250;setStatus("Watcher connected");};ws.onmessage=(event)=>{try{handleWatch(JSON.parse(event.data) as WatchMessage);}catch(error){setStatus(String(error),true);}};ws.onclose=()=>{setStatus("watcher disconnected",true);setTimeout(connect,state.retry);state.retry=Math.min(2000,state.retry*2);};}
function toggleSidebar(){const sidebar=$("#sidebar");const collapsed=sidebar.classList.toggle("collapsed");$(".workspace").classList.toggle("sidebar-collapsed",collapsed);const button=$("#sidebar-toggle");button.textContent=collapsed?"›":"‹";button.setAttribute("aria-label",collapsed?"Expand file tree":"Collapse file tree");button.setAttribute("aria-expanded",String(!collapsed));}
const diagramStage=$("#diagram-stage");
const dragState={pointerId:null as number|null,startX:0,startY:0,lastX:0,lastY:0,moved:false,suppressClick:false};
function zoomAtStageCenter(factor:number):void{const rect=diagramStage.getBoundingClientRect();viewport.zoomAt(factor,rect.width/2,rect.height/2);}
function finishDrag(event:PointerEvent,suppressClick:boolean):void{if(dragState.pointerId!==event.pointerId)return;if(diagramStage.hasPointerCapture(event.pointerId))diagramStage.releasePointerCapture(event.pointerId);const moved=dragState.moved;dragState.pointerId=null;dragState.moved=false;diagramStage.classList.remove("dragging");if(moved&&suppressClick){dragState.suppressClick=true;setTimeout(()=>{dragState.suppressClick=false;},0);}}
function onDiagramSourceClick(event:MouseEvent):void{const link=event.target instanceof Element?event.target.closest(".uml-source-link"):null;if(!link)return;if(dragState.suppressClick){event.preventDefault();return;}const source=sourceFromLink(link);if(source){event.preventDefault();void openSource(source);}}
function onDiagramSourceKeydown(event:KeyboardEvent):void{if(event.key!=="Enter"&&event.key!==" ")return;const link=event.target instanceof Element?event.target.closest(".uml-source-link"):null;if(!link)return;const source=sourceFromLink(link);if(source){event.preventDefault();void openSource(source);}}
function externalScopeFromLink(link:Element):string|undefined{const scopePath=(link as HTMLElement).dataset.scopePath;return scopePath||undefined;}
function openExternalUml(scopePath:string):void{void selectScope({name:scopePath.split("/").at(-1)??scopePath,path:scopePath,kind:"file"});}
function onDiagramExternalClick(event:MouseEvent):void{const link=event.target instanceof Element?event.target.closest(".uml-external-link"):null;if(!link)return;if(dragState.suppressClick){event.preventDefault();return;}const scopePath=externalScopeFromLink(link);if(scopePath){event.preventDefault();openExternalUml(scopePath);}}
function onDiagramExternalKeydown(event:KeyboardEvent):void{if(event.key!=="Enter"&&event.key!==" ")return;const link=event.target instanceof Element?event.target.closest(".uml-external-link"):null;if(!link)return;const scopePath=externalScopeFromLink(link);if(scopePath){event.preventDefault();openExternalUml(scopePath);}}
$("#packages-mode").onclick=()=>void selectScope({name:"Packages",path:"",kind:"directory"});$("#uml-mode").onclick=()=>{if(state.scope)void selectScope({name:"Selected",path:state.scope,kind:"directory"});};$("#editor-mode").onclick=()=>activateView("editor");$("#tree-filter").oninput=renderTree;$("#zoom-in").onclick=()=>zoomAtStageCenter(ZOOM_IN_FACTOR);$("#zoom-out").onclick=()=>zoomAtStageCenter(ZOOM_OUT_FACTOR);$("#zoom-reset").onclick=()=>viewport.reset();$("#legend-toggle").onclick=()=>{$("#legend").hidden=!$("#legend").hidden;};$("#sidebar-toggle").onclick=toggleSidebar;$("#editor-close").onclick=()=>{destroyEditor();activateView(state.mode);};$("#format-file").onclick=()=>void formatFile();$("#save-file").onclick=()=>void saveFile();$("#reload-file").onclick=()=>void reloadOpenFile();$("#keep-file").onclick=()=>{state.conflict=false;$("#conflict").hidden=true;setStatus("Keeping browser buffer");};
diagramStage.addEventListener("wheel",(event)=>{if(diagramStage.getAttribute("aria-busy")==="true")return;event.preventDefault();const rect=diagramStage.getBoundingClientRect();viewport.zoomAt(event.deltaY>0?ZOOM_OUT_FACTOR:ZOOM_IN_FACTOR,event.clientX-rect.left,event.clientY-rect.top);},{passive:false});
diagramStage.addEventListener("pointerdown",(event)=>{if(diagramStage.getAttribute("aria-busy")==="true"||event.button!==0||dragState.pointerId!==null)return;dragState.pointerId=event.pointerId;dragState.startX=dragState.lastX=event.clientX;dragState.startY=dragState.lastY=event.clientY;dragState.moved=false;});
diagramStage.addEventListener("pointermove",(event)=>{if(dragState.pointerId!==event.pointerId)return;if(!dragState.moved){if(!hasPassedDragThreshold(dragState.startX,dragState.startY,event.clientX,event.clientY))return;dragState.moved=true;diagramStage.setPointerCapture(event.pointerId);diagramStage.classList.add("dragging");}panViewport(viewport,event.clientX-dragState.lastX,event.clientY-dragState.lastY);dragState.lastX=event.clientX;dragState.lastY=event.clientY;viewport.apply();});
window.addEventListener("pointerup",(event)=>finishDrag(event,true));
window.addEventListener("pointercancel",(event)=>finishDrag(event,false));
$("#svg-holder").addEventListener("click",onDiagramSourceClick);
$("#svg-holder").addEventListener("keydown",onDiagramSourceKeydown);
$("#svg-holder").addEventListener("click",onDiagramExternalClick);
$("#svg-holder").addEventListener("keydown",onDiagramExternalKeydown);
await loadTree();await loadDiagram();connect();
