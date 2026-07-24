import mermaid from "mermaid";
import { basicSetup, EditorView } from "codemirror";
import { Decoration } from "@codemirror/view";
import { EditorSelection, EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import type {
  EditorGotoDefinition,
  GotoDefinition,
  GotoDefinitionLookupResponse,
  PackageDiagramNode,
  PreprocessControlRequest,
  PreprocessPriorityResponse,
  SearchResponse,
  UmlExternalUser,
  UmlLocalUser,
  UmlSourceLocation,
} from "../types.ts";
import {
  adjacentTreeRowIndex,
  RequestSequence,
  externalUserIdFromNodeId,
  formatUmlMethodReturnLabel,
  localUserIdFromNodeId,
  packageNodeIdFromNodeId,
  hasPassedDragThreshold,
  matchesSearchQuery,
  panViewport,
  shouldStackDiagram,
  treeScrollTopForRow,
  zoomViewportAt,
  type ViewportState,
} from "./diagram-interactions.ts";

type TreeNode={name:string;path:string;kind:"directory"|"file";children?:TreeNode[];viewable?:boolean};
type Diagram={kind:"packages"|"uml";scopePath:string;version:number;status:"ready"|"error";dsl:string;dsls:string[];packageNodes:PackageDiagramNode[];definitions:GotoDefinition[];externalUsers:UmlExternalUser[];localUsers:UmlLocalUser[];error?:string};
type FileResponse={path:string;content:string;definitions:EditorGotoDefinition[];cursorOffset?:number};
type WatchMessage={type:"changed";version:number;paths:string[];events:string[]}|{type:"cache-ready";version:number}|{type:"watch-error";version:number;error:string};
function $<T extends Element = HTMLInputElement>(selector:string):T{const element=document.querySelector<T>(selector);if(!element)throw new Error(`Missing required element: ${selector}`);return element;}
const state={tree:null as TreeNode|null,mode:"packages" as "packages"|"uml",activeView:"packages" as "packages"|"uml"|"editor",scope:"",umlScope:"",search:"",searchCaseInsensitive:false,searchFiles:new Set<string>(),searchDirs:new Set<string>(),searchDefinitions:[] as GotoDefinition[],version:0,file:null as FileResponse|null,view:null as EditorView|null,retry:250,expandedDirs:new Set<string>()};
const ZOOM_IN_FACTOR=1.25;
const ZOOM_OUT_FACTOR=1/ZOOM_IN_FACTOR;
const viewport:ViewportState&{apply():void;reset():void;zoomAt(factor:number,x:number,y:number):void}={scale:1,x:0,y:0,apply(){$("#svg-holder").style.transform=`translate(${this.x}px,${this.y}px) scale(${this.scale})`;},reset(){this.scale=1;this.x=0;this.y=0;this.apply();const stage=$("#diagram-stage");stage.scrollLeft=0;stage.scrollTop=0;},zoomAt(factor,x,y){zoomViewportAt(this,factor,x,y);this.apply();}};
const diagramRequests=new RequestSequence();
const searchRequests=new RequestSequence();
const priorityRequests=new RequestSequence();
const definitionRequests=new RequestSequence();
const editorRequests=new RequestSequence();
const emittedUmlScopes=new Set<string>();
const diagramLoadingState={loading:false,showMessage:false};
let activeScopeSyncToken:number|undefined;
let deferredOpenFileRefresh=false;
mermaid.initialize({startOnLoad:false,securityLevel:"strict",theme:"dark"});
async function api<T>(url:string,init?:RequestInit):Promise<T>{const response=await fetch(url,init);const body=await response.json() as T & {error?:string};if(!response.ok)throw new Error(body.error??`Request failed (${response.status})`);return body;}
type PriorityPollResult={cancelled:true}|{cancelled:false;response:PreprocessPriorityResponse};
const CANCELLED_PRIORITY_RESULT:PriorityPollResult={cancelled:true};
async function sendPreprocessControl(request:PreprocessControlRequest):Promise<PreprocessPriorityResponse>{
  return api<PreprocessPriorityResponse>("/api/preprocess",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify(request),
  });
}
async function prioritizeScope(
  resource:string,
  sequence:RequestSequence,
  token:number,
):Promise<PriorityPollResult>{
  let response=await sendPreprocessControl({
    action:"prioritize",
    resource:resource===""?".":`./${resource}`,
  });
  if(!sequence.isCurrent(token))return CANCELLED_PRIORITY_RESULT;
  while(response.status!=="done"){
    await new Promise<void>((resolve)=>setTimeout(resolve,100));
    if(!sequence.isCurrent(token))return CANCELLED_PRIORITY_RESULT;
    response=await sendPreprocessControl({action:"poll",requestId:response.requestId});
    if(!sequence.isCurrent(token))return CANCELLED_PRIORITY_RESULT;
  }
  return{cancelled:false,response};
}
function setStatus(text:string,error=false){const node=$("#status");node.textContent=text;node.classList.toggle("error",error);}
function showError(error:string|undefined){const panel=$("#error-panel");panel.textContent=error??"";panel.hidden=!error;}
function applyDiagramLoading():void{
  const loading=diagramLoadingState.loading||activeScopeSyncToken!==undefined;
  const showMessage=diagramLoadingState.showMessage||activeScopeSyncToken!==undefined;
  const panel=$("#diagram-loading");
  panel.hidden=!showMessage;
  const stage=$("#diagram-stage");
  stage.setAttribute("aria-busy",String(loading));
  stage.classList.toggle("loading",loading);
  if(loading)showError(undefined);
}
function setDiagramLoading(loading:boolean,showMessage=false):void{
  diagramLoadingState.loading=loading;
  diagramLoadingState.showMessage=showMessage;
  applyDiagramLoading();
}
function supersedeScopeSyncLoading():void{
  activeScopeSyncToken=undefined;
  deferredOpenFileRefresh=false;
  applyDiagramLoading();
}
function beginScopeSyncLoading(token:number):void{
  activeScopeSyncToken=token;
  applyDiagramLoading();
}
function endScopeSyncLoading(token:number):void{
  if(activeScopeSyncToken!==token)return;
  activeScopeSyncToken=undefined;
  applyDiagramLoading();
  const refreshOpenFile=deferredOpenFileRefresh;
  deferredOpenFileRefresh=false;
  if(refreshOpenFile&&state.file)void reloadOpenFile();
}
function setEditorLoading(loading:boolean):void{$("#editor-loading").hidden=!loading;}
function parseMethodName(text:string):string{const normalized=text.trim().replace(/^\\?[+\-#~]/,"");const parenthesis=normalized.indexOf("(");return (parenthesis===-1?normalized:normalized.slice(0,parenthesis)).trim();}
function sourceFromLink(link:Element):UmlSourceLocation|undefined{const data=(link as HTMLElement).dataset;const line=Number(data.sourceLine);const column=Number(data.sourceColumn);if(!data.sourcePath||!Number.isInteger(line)||!Number.isInteger(column))return undefined;return{path:data.sourcePath,line,column};}
function makeSourceLink(element:Element,location:UmlSourceLocation,label:string):void{element.classList.add("uml-source-link");element.setAttribute("role","link");element.setAttribute("tabindex","0");element.setAttribute("aria-label",`Open ${label} in editor`);const data=(element as HTMLElement).dataset;data.sourcePath=location.path;data.sourceLine=String(location.line);data.sourceColumn=String(location.column);}
function decoratePackageNodes(root:Element,packageNodes:readonly PackageDiagramNode[]):void{const byId=new Map(packageNodes.map((pkg)=>[pkg.nodeId,pkg]));for(const node of root.querySelectorAll<SVGGElement>("g.node")){const nodeId=packageNodeIdFromNodeId(node.id);if(!nodeId)continue;const pkg=byId.get(nodeId);if(!pkg)continue;node.classList.add("package-link");node.setAttribute("role","link");node.setAttribute("tabindex","0");node.setAttribute("aria-label",`Open ${pkg.name} UML`);node.dataset.packageName=pkg.name;node.dataset.scopePath=pkg.path;}}
function decorateUmlLocalUsers(root:Element,localUsers:readonly UmlLocalUser[]):void{const byId=new Map(localUsers.map((user)=>[user.nodeId,user]));for(const node of root.querySelectorAll<SVGGElement>("g.node")){const nodeId=localUserIdFromNodeId(node.id);if(!nodeId)continue;const local=byId.get(nodeId);if(!local)continue;const title=node.querySelector(".label-group .label, .classTitle");if(title)makeSourceLink(title,local,local.label);}}
function decorateUmlExternalUsers(root:Element,externalUsers:readonly UmlExternalUser[]):void{const byId=new Map(externalUsers.map((user)=>[user.nodeId,user]));for(const node of root.querySelectorAll<SVGGElement>("g.node")){const nodeId=externalUserIdFromNodeId(node.id);if(!nodeId)continue;const external=byId.get(nodeId);if(!external)continue;const title=node.querySelector(".label-group .label, .classTitle");if(!title)continue;title.classList.add("uml-external-link");title.setAttribute("role","link");title.setAttribute("tabindex","0");title.setAttribute("aria-label","Open external user UML");(title as HTMLElement).dataset.scopePath=external.scopePath;}}
function bareDiagramName(name:string):string{const generic=name.search(/[<~]/);return generic===-1?name:name.slice(0,generic);}
function compareDefinitions(left:GotoDefinition,right:GotoDefinition):number{return left.source.path.localeCompare(right.source.path)||left.source.line-right.source.line||left.source.column-right.source.column||left.key.localeCompare(right.key);}
function makeDefinitionLink(element:Element,definition:GotoDefinition,label:string):void{element.classList.add("uml-definition-link");element.setAttribute("role","link");element.setAttribute("tabindex","0");element.setAttribute("aria-label",`Open ${label} UML definition`);const data=(element as HTMLElement).dataset;data.sourcePath=definition.source.path;data.sourceLine=String(definition.source.line);data.sourceColumn=String(definition.source.column);}
function decorateUmlDefinitions(root:Element,definitions:readonly GotoDefinition[]):void{
  const ordered=[...definitions].sort(compareDefinitions);
  for(const node of root.querySelectorAll<SVGGElement>("g.node")){
    const match=/classId-(.+)-\d+$/.exec(node.id);
    if(!match)continue;
    const entityName=match[1];if(entityName===undefined)continue;
    const candidates=ordered.filter((definition)=>bareDiagramName(definition.uml.entityName)===bareDiagramName(entityName));
    const entity=candidates.find((definition)=>definition.kind!=="method");
    const title=node.querySelector(".label-group .label, .classTitle");
    if(title){
      (title as HTMLElement).dataset.searchText=(title.textContent??"").trim()||entityName;
      if(entity)makeDefinitionLink(title,entity,entity.qualifiedName);
    }
    const occurrences=new Map<string,number>();
    for(const label of node.querySelectorAll(".methods-group > .label")){
      const formattedReturn=formatUmlMethodReturnLabel(label.textContent??"");
      if(formattedReturn!==undefined){
        const content=label.querySelector(".nodeLabel p, .nodeLabel")??label;
        content.textContent=formattedReturn;
        continue;
      }
      const methodName=parseMethodName(label.textContent??"");
      if(!methodName)continue;
      (label as HTMLElement).dataset.searchText=methodName;
      const occurrence=occurrences.get(methodName)??0;
      occurrences.set(methodName,occurrence+1);
      const method=candidates.find((definition)=>
        definition.kind==="method"
        && definition.uml.memberName===methodName
        && definition.uml.memberOccurrence===occurrence
      );
      if(method)makeDefinitionLink(label,method,method.qualifiedName);
    }
  }
}
function focusUmlDefinition(location:UmlSourceLocation):boolean{
  const target=[...document.querySelectorAll<HTMLElement>("#svg-holder .uml-definition-link")].find((element)=>
    element.dataset.sourcePath===location.path
    && Number(element.dataset.sourceLine)===location.line
    && Number(element.dataset.sourceColumn)===location.column
  );
  if(!target)return false;
  document.querySelectorAll("#svg-holder .definition-target").forEach((element)=>{element.classList.remove("definition-target");});
  target.classList.add("definition-target");
  target.scrollIntoView({block:"center",inline:"center"});
  target.focus({preventScroll:true});
  return true;
}
function applySearchHighlights():void{
  const input=$("#node-search");
  for(const element of document.querySelectorAll("#svg-holder .search-match"))element.classList.remove("search-match");
  if(!state.search){
    input.classList.remove("no-match");
    input.removeAttribute("aria-invalid");
    return;
  }
  if(state.activeView==="uml"){
    for(const candidate of document.querySelectorAll<HTMLElement>("#svg-holder [data-search-text]")){
      candidate.classList.toggle("search-match",matchesSearchQuery(candidate.dataset.searchText??"",state.search,state.searchCaseInsensitive));
    }
  }
  const failed=state.searchFiles.size===0;
  input.classList.toggle("no-match",failed);
  if(failed)input.setAttribute("aria-invalid","true");else input.removeAttribute("aria-invalid");
}
function renderTree(){
  const root=$("#tree");
  const activeElement=document.activeElement;
  const focusedPath=activeElement instanceof HTMLElement&&activeElement.matches("#tree .tree-row")
    ?activeElement.dataset.treePath
    :undefined;
  root.replaceChildren();
  if(!state.tree){applySearchHighlights();return;}
  const filter=$("#tree-filter").value.toLowerCase();
  const buttonsByPath=new Map<string,HTMLButtonElement>();
  type DrawResult={element:HTMLElement;hasSearchMatch:boolean};
  const draw=(node:TreeNode):DrawResult|null=>{
    const isDir=node.kind==="directory";
    const nodeSearchMatch=isDir?state.searchDirs.has(node.path):state.searchFiles.has(node.path);
    const children:DrawResult[]=[];
    for(const childNode of node.children??[]){
      const child=draw(childNode);
      if(child)children.push(child);
    }
    const hasSearchMatch=nodeSearchMatch||children.some((child)=>child.hasSearchMatch);
    const matching=!filter||node.name.toLowerCase().includes(filter)||node.path.toLowerCase().includes(filter);
    if(!matching&&!children.length&&!nodeSearchMatch)return null;
    const expanded=isDir&&(state.expandedDirs.has(node.path)||Boolean(filter)||hasSearchMatch);
    const wrap=document.createElement("div");
    const button=document.createElement("button");
    button.className=`tree-row ${state.scope===node.path&&state.mode===(node.kind==="file"?state.mode:"uml")?"selected":""} ${nodeSearchMatch?"search-match":""}`.trim();
    button.dataset.treePath=node.path;
    button.innerHTML=`<span class="icon">${isDir?(expanded?"▾":"▸"):"·"}</span><span>${node.name}</span>`;
    if(isDir)button.setAttribute("aria-expanded",String(expanded));
    button.onclick=()=>{
      if(isDir){
        if(state.expandedDirs.has(node.path))state.expandedDirs.delete(node.path);else state.expandedDirs.add(node.path);
        void selectScope(node);
      }else if(node.viewable)void openFile(node.path);else void selectScope(node,"uml");
    };
    buttonsByPath.set(node.path,button);
    wrap.append(button);
    if(children.length&&expanded){
      const nested=document.createElement("div");
      nested.className="tree-children";
      children.forEach((child)=>{nested.append(child.element);});
      wrap.append(nested);
    }
    return{element:wrap,hasSearchMatch};
  };
  const result=draw(state.tree);
  if(result)root.append(result.element);
  if(focusedPath!==undefined)buttonsByPath.get(focusedPath)?.focus({preventScroll:true});
  applySearchHighlights();
}
function collectDirectoryPaths(node:TreeNode,paths=new Set<string>()):Set<string>{if(node.kind==="directory")paths.add(node.path);for(const child of node.children??[])collectDirectoryPaths(child,paths);return paths;}
let treeRefreshPromise:Promise<void>|undefined;
let treeRefreshRequested=false;
function loadTree():Promise<void>{
  treeRefreshRequested=true;
  if(treeRefreshPromise)return treeRefreshPromise;
  treeRefreshPromise=(async()=>{
    while(treeRefreshRequested){
      treeRefreshRequested=false;
      try{
        const response=await api<{version:number;root:TreeNode}>("/api/tree");
        if(treeRefreshRequested)continue;
        const firstTree=state.tree===null;
        const directories=collectDirectoryPaths(response.root);
        state.expandedDirs=new Set([...state.expandedDirs].filter((path)=>directories.has(path)));
        if(firstTree)state.expandedDirs.add(response.root.path);
        state.tree=response.root;
        state.version=response.version;
        $("#source-label").textContent=response.root.name;
        renderTree();
      }catch(error){
        if(treeRefreshRequested)continue;
        throw error;
      }
    }
  })().finally(()=>{treeRefreshPromise=undefined;});
  return treeRefreshPromise;
}
type UmlScopeRenderResult={nextFrameIndex:number;complete:boolean};
async function renderUmlScope(
  scope:string,
  diagram:Diagram,
  holder:HTMLElement,
  renderToken:number,
  directoryIndex:number,
  frameIndexOffset:number,
  isCurrent:()=>boolean,
  errors:string[],
  scopedErrors:boolean,
):Promise<UmlScopeRenderResult>{
  let nextFrameIndex=frameIndexOffset;
  for(const [frameIndex,dsl] of diagram.dsls.entries()){
    const frame=document.createElement("div");
    frame.className="uml-frame";
    frame.setAttribute("role","listitem");
    frame.setAttribute("aria-label",`UML diagram ${nextFrameIndex+1}`);
    frame.dataset.index=String(nextFrameIndex);
    try{
      const rendered=await mermaid.render(`diagram-${renderToken}-${directoryIndex}-${frameIndex}`,dsl);
      if(!isCurrent())return{nextFrameIndex,complete:false};
      frame.innerHTML=rendered.svg;
      decorateUmlDefinitions(frame,diagram.definitions);
      decorateUmlExternalUsers(frame,diagram.externalUsers);
      decorateUmlLocalUsers(frame,diagram.localUsers);
    }catch(error){
      if(!isCurrent())return{nextFrameIndex,complete:false};
      const message=error instanceof Error?error.message:String(error);
      frame.classList.add("error");
      frame.textContent=`Diagram ${frameIndex+1}: ${message}`;
      errors.push(scopedErrors?`[${scope}] diagram ${frameIndex+1}: ${message}`:`Diagram ${frameIndex+1}: ${message}`);
    }
    holder.append(frame);
    nextFrameIndex++;
  }
  return{nextFrameIndex,complete:true};
}
async function loadDiagram(
  token=diagramRequests.next(),
  definitionToken?:number,
  focus?:UmlSourceLocation,
):Promise<void>{
  const isCurrent=()=>diagramRequests.isCurrent(token)
    &&(definitionToken===undefined||definitionRequests.isCurrent(definitionToken));
  const showLoading=state.mode==="uml"&&!emittedUmlScopes.has(state.scope);
  if(showLoading)emittedUmlScopes.add(state.scope);
  if(isCurrent())setDiagramLoading(state.mode==="uml",showLoading);
  try{
    const query=new URLSearchParams({kind:state.mode,path:state.scope});
    const diagram=await api<Diagram>(`/api/diagram?${query}`);
    if(!isCurrent())return;
    state.version=diagram.version;
    $("#dsl-content").textContent=diagram.dsl;
    showError(diagram.status==="error"?diagram.error:undefined);
    const holder=$("#svg-holder");
    if(shouldStackDiagram(state.mode)){
      holder.innerHTML="";
      holder.classList.add("stacked");
      holder.setAttribute("role","list");
      const errors:string[]=[];
      const result=await renderUmlScope(
        state.scope||".",
        diagram,
        holder,
        token,
        0,
        0,
        isCurrent,
        errors,
        false,
      );
      if(!result.complete||!isCurrent())return;
      applySearchHighlights();
      viewport.apply();
      if(focus&&!focusUmlDefinition(focus)){
        showError("Definition not found");
        setStatus("Definition not found",true);
      }else if(errors.length){
        showError(errors.join("\n"));
        setStatus("Mermaid render error",true);
      }else setStatus(diagram.status==="error"?"Diagram parse error":`Updated · v${diagram.version}`,diagram.status==="error");
      return;
    }
    holder.classList.remove("stacked");
    holder.removeAttribute("role");
    try{
      const rendered=await mermaid.render(`diagram-${token}`,diagram.dsl);
      if(!isCurrent())return;
      holder.innerHTML=rendered.svg;
      decoratePackageNodes(holder,diagram.packageNodes);
      decorateUmlDefinitions(holder,diagram.definitions);
      decorateUmlExternalUsers(holder,diagram.externalUsers);
      decorateUmlLocalUsers(holder,diagram.localUsers);
      applySearchHighlights();
      viewport.apply();
      if(focus&&!focusUmlDefinition(focus)){
        showError("Definition not found");
        setStatus("Definition not found",true);
      }else setStatus(diagram.status==="error"?"Diagram parse error":`Updated · v${diagram.version}`,diagram.status==="error");
    }catch(error){
      if(!isCurrent())return;
      showError(error instanceof Error?error.message:String(error));
      setStatus("Mermaid render error",true);
    }
  }catch(error){
    if(!isCurrent())return;
    throw error;
  }finally{
    if(isCurrent())setDiagramLoading(false);
  }
}
function renderDefinitionResults():void{
  const results=$("#definition-results");
  results.replaceChildren();
  for(const definition of state.searchDefinitions){
    const button=document.createElement("button");
    button.type="button";
    button.className="definition-result";
    button.setAttribute("role","option");
    const name=document.createElement("span");
    name.className="definition-result-name";
    name.textContent=`${definition.kind} · ${definition.qualifiedName}`;
    const location=document.createElement("span");
    location.className="definition-result-location";
    location.textContent=`${definition.source.path}:${definition.source.line}`;
    button.append(name,location);
    button.onclick=()=>void navigateToDefinition(
      definition.source,
      state.activeView==="editor"?"editor":"uml",
    );
    results.append(button);
  }
  results.hidden=state.searchDefinitions.length===0;
}

function clearSearch():void{
  definitionRequests.next();
  searchRequests.next();
  diagramRequests.next();
  setDiagramLoading(false);
  state.search="";
  state.searchFiles.clear();
  state.searchDirs.clear();
  state.searchDefinitions=[];
  renderDefinitionResults();
  renderTree();
}
async function renderSearchDiagrams(renderDirs:readonly string[],searchToken:number):Promise<void>{
  const renderToken=diagramRequests.next();
  const isCurrent=()=>searchRequests.isCurrent(searchToken)&&diagramRequests.isCurrent(renderToken);
  state.mode="uml";
  state.scope="";
  activateView("uml");
  viewport.reset();
  setDiagramLoading(true);
  const holder=$("#svg-holder");
  holder.replaceChildren();
  holder.classList.add("stacked");
  holder.setAttribute("role","list");
  const errors:string[]=[];
  const dslSections:string[]=[];
  let frameIndex=0;
  try{
    for(const [directoryIndex,renderDir] of renderDirs.entries()){
      const scope=renderDir||".";
      let diagram:Diagram;
      try{
        diagram=await api<Diagram>(`/api/diagram?kind=uml&path=${encodeURIComponent(renderDir)}`);
        if(!isCurrent())return;
      }catch(error){
        if(!isCurrent())return;
        const message=error instanceof Error?error.message:String(error);
        errors.push(`[${scope}] request: ${message}`);
        continue;
      }
      dslSections.push(`%% Scope: ${scope}\n${diagram.dsl}`);
      if(diagram.status==="error")errors.push(`[${scope}] ${diagram.error??"Diagram parse error"}`);
      const result=await renderUmlScope(
        scope,
        diagram,
        holder,
        renderToken,
        directoryIndex,
        frameIndex,
        isCurrent,
        errors,
        true,
      );
      if(!result.complete)return;
      frameIndex=result.nextFrameIndex;
    }
    if(!isCurrent())return;
    $("#dsl-content").textContent=dslSections.join("\n\n");
    applySearchHighlights();
    viewport.apply();
    if(errors.length){
      showError(errors.join("\n"));
      setStatus("Search diagram render error",true);
    }else{
      showError(undefined);
      setStatus(`Search · ${state.searchFiles.size} files · v${state.version}`);
    }
  }finally{
    if(diagramRequests.isCurrent(renderToken))setDiagramLoading(false);
  }
}
async function commitSearch(query:string,caseInsensitive:boolean):Promise<void>{
  if(!query){clearSearch();return;}
  definitionRequests.next();
  const activeView=state.activeView;
  const token=searchRequests.next();
  diagramRequests.next();
  setDiagramLoading(false);
  state.search=query;
  state.searchCaseInsensitive=caseInsensitive;
  state.searchFiles=new Set();
  state.searchDirs=new Set();
  state.searchDefinitions=[];
  renderDefinitionResults();
  renderTree();
  for(const element of document.querySelectorAll("#svg-holder .search-match"))element.classList.remove("search-match");
  const input=$("#node-search");
  input.classList.remove("no-match");
  input.removeAttribute("aria-invalid");
  try{
    const params=new URLSearchParams({q:query,caseInsensitive:String(caseInsensitive)});
    const response=await api<SearchResponse>(`/api/search?${params}`);
    if(!searchRequests.isCurrent(token))return;
    if(response.caseInsensitive!==caseInsensitive)throw new Error("Search response mode mismatch");
    state.search=response.query;
    state.searchFiles=new Set(response.files);
    state.searchDirs=new Set(response.directories);
    state.searchDefinitions=response.definitions;
    state.searchCaseInsensitive=response.caseInsensitive;
    state.version=response.version;
    renderDefinitionResults();
    renderTree();
    if(activeView==="editor"){
      setStatus(`Search · ${response.definitions.length} definitions · v${response.version}`);
      return;
    }
    if(response.files.length===0)return;
    await renderSearchDiagrams(response.renderDirs,token);
  }catch(error){
    if(!searchRequests.isCurrent(token))return;
    state.search=query;
    state.searchCaseInsensitive=caseInsensitive;
    state.searchFiles=new Set();
    state.searchDirs=new Set();
    state.searchDefinitions=[];
    renderDefinitionResults();
    renderTree();
    setStatus(error instanceof Error?error.message:String(error),true);
  }
}
function activateView(view:"packages"|"uml"|"editor"){state.activeView=view;const activeButtonId=view==="editor"?"editor-mode":`${state.mode}-mode`;document.querySelectorAll(".mode").forEach((button)=>{button.classList.toggle("active",button.id===activeButtonId);});const editorActive=view==="editor";$("#graph-panel").hidden=editorActive;$("#editor-panel").hidden=!editorActive;const hasFile=state.file!==null;$("#editor-empty").hidden=hasFile;$("#editor-content").hidden=!hasFile;applySearchHighlights();}
type DefinitionNavigationContext={
  definitionToken:number;
  diagramToken:number;
  editorToken:number;
};
function definitionContextCurrent(context:DefinitionNavigationContext):boolean{
  return definitionRequests.isCurrent(context.definitionToken)
    &&diagramRequests.isCurrent(context.diagramToken)
    &&editorRequests.isCurrent(context.editorToken);
}
async function selectScope(
  node:TreeNode,
  requestedMode?: "packages"|"uml",
  context?:DefinitionNavigationContext,
  focus?:UmlSourceLocation,
):Promise<boolean>{
  if(!context){
    definitionRequests.next();
    editorRequests.next();
  }
  const diagramToken=context?.diagramToken??diagramRequests.next();
  const priorityToken=priorityRequests.next();
  supersedeScopeSyncLoading();
  const isCurrent=()=>priorityRequests.isCurrent(priorityToken)
    &&diagramRequests.isCurrent(diagramToken)
    &&(context===undefined||definitionContextCurrent(context));
  searchRequests.next();
  if(!isCurrent())return false;
  state.mode=requestedMode??(node.path===""?"packages":"uml");
  state.scope=state.mode==="packages"?"":node.path;
  if(state.mode==="uml")state.umlScope=node.path;
  activateView(state.mode);
  viewport.reset();
  renderTree();
  const syncClickedScope=state.mode==="uml"&&node.kind==="directory";
  if(syncClickedScope)beginScopeSyncLoading(priorityToken);
  try{
    if(syncClickedScope){
      const priority=await prioritizeScope(node.path,priorityRequests,priorityToken);
      if(priority.cancelled)return false;
    }
    if(!isCurrent())return false;
    await loadDiagram(diagramToken,context?.definitionToken,focus);
    return isCurrent();
  }catch(error){
    if(!isCurrent())return false;
    setDiagramLoading(false);
    showError(error instanceof Error?error.message:String(error));
    setStatus("Request failed",true);
    return false;
  }finally{
    if(syncClickedScope)endScopeSyncLoading(priorityToken);
  }
}
function destroyEditor(invalidate=true):void{
  if(invalidate){
    definitionRequests.next();
    editorRequests.next();
  }
  state.view?.destroy();
  state.view=null;
  state.file=null;
  $("#editor-content").hidden=true;
  $("#editor-empty").hidden=false;
}
function revealEditorOffset(offset:number,focus=true):void{if(!state.view)return;const clamped=Math.max(0,Math.min(offset,state.view.state.doc.length));state.view.dispatch({selection:EditorSelection.cursor(clamped),effects:EditorView.scrollIntoView(clamped,{y:"center"})});if(focus)state.view.focus();}
function editorDefinitionDecorations(file:FileResponse){
  return Decoration.set(file.definitions.flatMap((definition)=>{
    if(definition.displayFrom<0||definition.displayTo>file.content.length||definition.displayFrom>=definition.displayTo)return[];
    return[Decoration.mark({
      class:"editor-definition-link",
      attributes:{
        role:"link",
        tabindex:"0",
        "aria-label":`Open ${definition.qualifiedName} editor definition`,
        "data-source-path":definition.source.path,
        "data-source-line":String(definition.source.line),
        "data-source-column":String(definition.source.column),
      },
    }).range(definition.displayFrom,definition.displayTo)];
  }),true);
}
function editorDefinitionHandlers(){
  const activate=(event:Event):boolean=>{
    const link=event.target instanceof Element?event.target.closest(".editor-definition-link"):null;
    if(!link)return false;
    const source=sourceFromLink(link);
    if(!source)return false;
    event.preventDefault();
    void navigateToDefinition(source,"editor");
    return true;
  };
  return EditorView.domEventHandlers({
    click:(event)=>activate(event),
    keydown:(event)=>{
      if(event.key!=="Enter"&&event.key!==" ")return false;
      return activate(event);
    },
  });
}
async function openSource(location:UmlSourceLocation):Promise<void>{await openFile(location.path,location);}
async function openFile(
  path:string,
  position?:UmlSourceLocation,
  context?:DefinitionNavigationContext,
  activate=true,
):Promise<boolean>{
  if(!context){
    definitionRequests.next();
    diagramRequests.next();
  }
  const editorToken=context?.editorToken??editorRequests.next();
  const isCurrent=()=>editorRequests.isCurrent(editorToken)
    &&(context===undefined||definitionContextCurrent(context));
  try{
    const query=new URLSearchParams({path});
    if(position){query.set("line",String(position.line));query.set("column",String(position.column));}
    const file=await api<FileResponse>(`/api/file?${query}`);
    if(!isCurrent())return false;
    destroyEditor(false);
    state.file=file;
    $("#editor-name").textContent=path.split("/").at(-1)??path;
    $("#editor-path").textContent=path;
    const typescript=/\.(?:ts|tsx|mts|cts)$/.test(path);
    const jsx=/\.(?:tsx|jsx)$/.test(path);
    const extensions=[
      basicSetup,
      javascript({typescript,jsx}),
      oneDark,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.decorations.of(editorDefinitionDecorations(file)),
      editorDefinitionHandlers(),
    ];
    state.view=new EditorView({state:EditorState.create({doc:file.content,extensions}),parent:$("#editor")});
    if(!isCurrent()){
      destroyEditor(false);
      return false;
    }
    if(activate)activateView("editor");
    if(file.cursorOffset!==undefined)revealEditorOffset(file.cursorOffset,activate);
    setStatus("Read-only preprocessed source");
    return true;
  }catch(error){
    if(!isCurrent())return false;
    setStatus(error instanceof Error?error.message:String(error),true);
    return false;
  }
}
async function lookupDefinition(location:UmlSourceLocation):Promise<GotoDefinitionLookupResponse>{
  const query=new URLSearchParams({
    path:location.path,
    line:String(location.line),
    column:String(location.column),
  });
  return api<GotoDefinitionLookupResponse>(`/api/goto-definition?${query}`);
}
function setDefinitionLoading(view:"uml"|"editor",loading:boolean):void{
  if(view==="uml")setDiagramLoading(loading,loading);
  else setEditorLoading(loading);
}
async function navigateToDefinition(
  location:UmlSourceLocation,
  view:"uml"|"editor",
):Promise<void>{
  const context:DefinitionNavigationContext={
    definitionToken:definitionRequests.next(),
    diagramToken:diagramRequests.next(),
    editorToken:editorRequests.next(),
  };
  try{
    let response=await lookupDefinition(location);
    if(!definitionContextCurrent(context))return;
    if(response.definition===null){
      setDefinitionLoading(view,true);
      const priority=await prioritizeScope(location.path,definitionRequests,context.definitionToken);
      if(priority.cancelled||!definitionContextCurrent(context))return;
      response=await lookupDefinition(location);
      if(!definitionContextCurrent(context))return;
    }
    const definition=response.definition;
    if(!definition)throw new Error("Definition not found");
    if(view==="editor"){
      await openFile(definition.source.path,definition.source,context);
    }else{
      const opened=await openFile(definition.source.path,definition.source,context,false);
      if(!opened||!definitionContextCurrent(context))return;
      await selectScope(
        {
          name:definition.name,
          path:definition.uml.scopePath,
          kind:"file",
        },
        "uml",
        context,
        definition.source,
      );
    }
  }catch(error){
    if(!definitionContextCurrent(context))return;
    const message=error instanceof Error?error.message:String(error);
    showError(message);
    setStatus(message,true);
  }finally{
    if(definitionContextCurrent(context))setDefinitionLoading(view,false);
  }
}
async function reloadOpenFile():Promise<void>{if(!state.file)return;const path=state.file.path;const activeView=state.activeView;await openFile(path);if(activeView!=="editor")activateView(activeView);}
function refreshCachedViews():void{
  definitionRequests.next();
  editorRequests.next();
  void loadTree().catch((error)=>setStatus(error instanceof Error?error.message:String(error),true));
  if(activeScopeSyncToken!==undefined){
    deferredOpenFileRefresh||=state.file!==null;
    return;
  }
  if(state.file)void reloadOpenFile();
  if(state.search&&state.mode==="uml"&&state.scope==="")void commitSearch(state.search,state.searchCaseInsensitive);
  else void loadDiagram();
}
function handleWatch(message:WatchMessage){
  if(message.type==="watch-error"){setStatus(message.error,true);return;}
  state.version=message.version;
  if(message.type==="cache-ready"){refreshCachedViews();setStatus(`Cache ready · v${message.version}`);return;}
  if(message.paths.length===0&&message.events.length===0){
    void loadTree().catch((error)=>setStatus(error instanceof Error?error.message:String(error),true));
    return;
  }
  refreshCachedViews();
  setStatus(`Source changed · v${message.version}`);
}
function connect(){const protocol=location.protocol==="https:"?"wss":"ws";const ws=new WebSocket(`${protocol}://${location.host}/ws`);ws.onopen=()=>{state.retry=250;setStatus("Watcher connected");};ws.onmessage=(event)=>{try{handleWatch(JSON.parse(event.data) as WatchMessage);}catch(error){setStatus(String(error),true);}};ws.onclose=()=>{setStatus("watcher disconnected",true);setTimeout(connect,state.retry);state.retry=Math.min(2000,state.retry*2);};}
function toggleSidebar(){const sidebar=$("#sidebar");const collapsed=sidebar.classList.toggle("collapsed");$(".workspace").classList.toggle("sidebar-collapsed",collapsed);const button=$("#sidebar-toggle");button.textContent=collapsed?"›":"‹";button.setAttribute("aria-label",collapsed?"Expand file tree":"Collapse file tree");button.setAttribute("aria-expanded",String(!collapsed));}
const diagramStage=$("#diagram-stage");
const dragState={pointerId:null as number|null,startX:0,startY:0,lastX:0,lastY:0,moved:false,suppressClick:false};
function zoomAtStageCenter(factor:number):void{const rect=diagramStage.getBoundingClientRect();viewport.zoomAt(factor,rect.width/2,rect.height/2);}
function finishDrag(event:PointerEvent,suppressClick:boolean):void{if(dragState.pointerId!==event.pointerId)return;if(diagramStage.hasPointerCapture(event.pointerId))diagramStage.releasePointerCapture(event.pointerId);const moved=dragState.moved;dragState.pointerId=null;dragState.moved=false;diagramStage.classList.remove("dragging");if(moved&&suppressClick){dragState.suppressClick=true;setTimeout(()=>{dragState.suppressClick=false;},0);}}
function onDiagramSourceClick(event:MouseEvent):void{const link=event.target instanceof Element?event.target.closest(".uml-source-link"):null;if(!link)return;if(dragState.suppressClick){event.preventDefault();return;}const source=sourceFromLink(link);if(source){event.preventDefault();void openSource(source);}}
function onDiagramDefinitionClick(event:MouseEvent):void{const link=event.target instanceof Element?event.target.closest(".uml-definition-link"):null;if(!link)return;if(dragState.suppressClick){event.preventDefault();return;}const source=sourceFromLink(link);if(source){event.preventDefault();void navigateToDefinition(source,"uml");}}
function onDiagramDefinitionKeydown(event:KeyboardEvent):void{if(event.key!=="Enter"&&event.key!==" ")return;const link=event.target instanceof Element?event.target.closest(".uml-definition-link"):null;if(!link)return;const source=sourceFromLink(link);if(source){event.preventDefault();void navigateToDefinition(source,"uml");}}
function onDiagramSourceKeydown(event:KeyboardEvent):void{if(event.key!=="Enter"&&event.key!==" ")return;const link=event.target instanceof Element?event.target.closest(".uml-source-link"):null;if(!link)return;const source=sourceFromLink(link);if(source){event.preventDefault();void openSource(source);}}
function externalScopeFromLink(link:Element):string|undefined{const scopePath=(link as HTMLElement).dataset.scopePath;return scopePath||undefined;}
function openExternalUml(scopePath:string):void{void selectScope({name:scopePath.split("/").at(-1)??scopePath,path:scopePath,kind:"file"});}
function onDiagramExternalClick(event:MouseEvent):void{const link=event.target instanceof Element?event.target.closest(".uml-external-link"):null;if(!link)return;if(dragState.suppressClick){event.preventDefault();return;}const scopePath=externalScopeFromLink(link);if(scopePath){event.preventDefault();openExternalUml(scopePath);}}
function onDiagramExternalKeydown(event:KeyboardEvent):void{if(event.key!=="Enter"&&event.key!==" ")return;const link=event.target instanceof Element?event.target.closest(".uml-external-link"):null;if(!link)return;const scopePath=externalScopeFromLink(link);if(scopePath){event.preventDefault();openExternalUml(scopePath);}}
function packageFromLink(link:Element):{name:string;path:string}|undefined{const data=(link as HTMLElement).dataset;if(!Object.hasOwn(data,"packageName")||!Object.hasOwn(data,"scopePath"))return undefined;return{name:data.packageName??"",path:data.scopePath??""};}
function openPackageUml(pkg:{name:string;path:string}):void{void selectScope({name:pkg.name,path:pkg.path,kind:"directory"},"uml");}
function onDiagramPackageClick(event:MouseEvent):void{const link=event.target instanceof Element?event.target.closest(".package-link"):null;if(!link)return;if(dragState.suppressClick){event.preventDefault();return;}const pkg=packageFromLink(link);if(pkg){event.preventDefault();openPackageUml(pkg);}}
function onDiagramPackageKeydown(event:KeyboardEvent):void{if(event.key!=="Enter"&&event.key!==" ")return;const link=event.target instanceof Element?event.target.closest(".package-link"):null;if(!link)return;const pkg=packageFromLink(link);if(pkg){event.preventDefault();openPackageUml(pkg);}}
const tree=$("#tree");
function scrollTreeRowIntoView(row:HTMLButtonElement):void{
  const treeRect=tree.getBoundingClientRect();
  const rowRect=row.getBoundingClientRect();
  tree.scrollTop=treeScrollTopForRow(
    tree.scrollTop,
    tree.scrollHeight-tree.clientHeight,
    treeRect.top,
    treeRect.bottom,
    rowRect.top,
    rowRect.bottom,
  );
}
tree.addEventListener("keydown",(event)=>{
  if(event.key!=="ArrowUp"&&event.key!=="ArrowDown")return;
  const current=event.target instanceof Element?event.target.closest<HTMLButtonElement>(".tree-row"):null;
  if(!current||!tree.contains(current))return;
  const rows=[...tree.querySelectorAll<HTMLButtonElement>(".tree-row")];
  const nextIndex=adjacentTreeRowIndex(rows.indexOf(current),event.key==="ArrowUp"?-1:1,rows.length);
  if(nextIndex<0)return;
  event.preventDefault();
  const next=rows[nextIndex];if(!next)return;
  next.focus({preventScroll:true});
  scrollTreeRowIntoView(next);
});
const nodeSearch=$("#node-search");
nodeSearch.onkeydown=(event)=>{if(event.key!=="Enter")return;event.preventDefault();void commitSearch(nodeSearch.value.trim(),$("#search-case-insensitive").checked);};
nodeSearch.oninput=()=>{if(nodeSearch.value!=="")return;clearSearch();};
$("#packages-mode").onclick=()=>void selectScope({name:"Packages",path:"",kind:"directory"},"packages");
$("#uml-mode").onclick=()=>void selectScope({name:"Selected",path:state.umlScope,kind:"directory"},"uml");
$("#editor-mode").onclick=()=>{definitionRequests.next();diagramRequests.next();activateView("editor");};$("#tree-filter").oninput=renderTree;$("#zoom-in").onclick=()=>zoomAtStageCenter(ZOOM_IN_FACTOR);$("#zoom-out").onclick=()=>zoomAtStageCenter(ZOOM_OUT_FACTOR);$("#zoom-reset").onclick=()=>viewport.reset();$("#legend-toggle").onclick=()=>{$("#legend").hidden=!$("#legend").hidden;};$("#sidebar-toggle").onclick=toggleSidebar;$("#editor-close").onclick=()=>{setEditorLoading(false);destroyEditor();activateView(state.mode);};
diagramStage.addEventListener("wheel",(event)=>{if(diagramStage.getAttribute("aria-busy")==="true")return;event.preventDefault();const rect=diagramStage.getBoundingClientRect();viewport.zoomAt(event.deltaY>0?ZOOM_OUT_FACTOR:ZOOM_IN_FACTOR,event.clientX-rect.left,event.clientY-rect.top);},{passive:false});
diagramStage.addEventListener("pointerdown",(event)=>{if(diagramStage.getAttribute("aria-busy")==="true"||event.button!==0||dragState.pointerId!==null)return;dragState.pointerId=event.pointerId;dragState.startX=dragState.lastX=event.clientX;dragState.startY=dragState.lastY=event.clientY;dragState.moved=false;});
diagramStage.addEventListener("pointermove",(event)=>{if(dragState.pointerId!==event.pointerId)return;if(!dragState.moved){if(!hasPassedDragThreshold(dragState.startX,dragState.startY,event.clientX,event.clientY))return;dragState.moved=true;diagramStage.setPointerCapture(event.pointerId);diagramStage.classList.add("dragging");}panViewport(viewport,event.clientX-dragState.lastX,event.clientY-dragState.lastY);dragState.lastX=event.clientX;dragState.lastY=event.clientY;viewport.apply();});
window.addEventListener("pointerup",(event)=>finishDrag(event,true));
window.addEventListener("pointercancel",(event)=>finishDrag(event,false));
$("#svg-holder").addEventListener("click",onDiagramDefinitionClick);
$("#svg-holder").addEventListener("keydown",onDiagramDefinitionKeydown);
$("#svg-holder").addEventListener("click",onDiagramSourceClick);
$("#svg-holder").addEventListener("keydown",onDiagramSourceKeydown);
$("#svg-holder").addEventListener("click",onDiagramExternalClick);
$("#svg-holder").addEventListener("keydown",onDiagramExternalKeydown);
$("#svg-holder").addEventListener("click",onDiagramPackageClick);
$("#svg-holder").addEventListener("keydown",onDiagramPackageKeydown);
await loadTree();
connect();
void loadDiagram().catch((error)=>{
  showError(error instanceof Error?error.message:String(error));
  setStatus("Request failed",true);
});
