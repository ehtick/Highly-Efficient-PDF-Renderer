import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { createPdfLayerControls } from "../src/pdfLayerControls.ts";

class Element extends EventTarget {
  childNodes=[]; value=""; textContent=""; checked=false; indeterminate=false; disabled=false; hidden=false;
  constructor(tag="div") { super(); this.tagName=tag; this.ownerDocument={createElement:tag=>new Element(tag)}; }
  append(...children) { this.childNodes.push(...children); }
  replaceChildren(...children) { this.childNodes=[...children]; this.textContent=""; }
  set innerHTML(_html) {
    this.elements=new Map([['input[type="search"]',new Element("input")],[".pdf-layers-all input",new Element("input")],[".pdf-layers-list",new Element()],
      ["button",new Element("button")],[".pdf-layers-status",new Element()],["progress",new Element("progress")]]);
  }
  querySelector(selector) { return this.elements.get(selector); }
}
const group=(id,name,visible,locked=false)=>({id,name,visible,defaultVisible:visible,locked,usedInView:true});
let layers=[group("walls","Walls <script>",true),group("doors","Doors",false),group("grid","Grid",true,true)];
let listener, pendingResolve, pendingReject;
const calls=[];
const container=new Element();
const controller={
  getLayers:()=>layers,
  getAllLayerVisibility() {
    const editable=layers.filter(l=>!l.locked&&l.usedInView), visible=editable.filter(l=>l.visible).length;
    return { checked:editable.length>0&&visible===editable.length, indeterminate:visible>0&&visible<editable.length, disabled:editable.length===0 };
  },
  getLayerOrder:()=>[{kind:"label",label:"Architecture",children:[{kind:"group",groupId:"walls",children:[{kind:"group",groupId:"doors"}]}]}],
  subscribeLayerVisibility(fn) { listener=fn; return ()=>{listener=null;}; },
  setLayerVisibility(id,visible) {
    calls.push([id,visible]); return new Promise((resolve,reject)=>{
      pendingResolve=()=>{layers=layers.map(l=>l.id===id?{...l,visible}:l);listener?.();resolve();};pendingReject=reject;
    });
  },
  setAllLayerVisibility(visible) {
    calls.push(["all",visible]); return new Promise((resolve,reject)=>{
      pendingResolve=()=>{layers=layers.map(l=>l.locked||!l.usedInView?l:{...l,visible});listener?.();resolve();};pendingReject=reject;
    });
  },
  async resetLayerVisibility() { calls.push("reset"); layers=layers.map(l=>({...l,visible:l.defaultVisible}));listener?.(); }
};
const widget=createPdfLayerControls({container,controller});
const filter=container.querySelector('input[type="search"]'), list=container.querySelector(".pdf-layers-list");
const all=container.querySelector(".pdf-layers-all input");
const status=container.querySelector(".pdf-layers-status"), progress=container.querySelector("progress");
const walk=node=>[node,...node.childNodes.flatMap(walk)];
const boxes=()=>walk(list).filter(n=>n.tagName==="input");
assert.equal(boxes().length,3,"unlisted layers remain available below PDF order");
assert.equal(all.checked,false);assert.equal(all.indeterminate,true);assert.equal(all.disabled,false);
assert.deepEqual(boxes().map(b=>[b.checked,b.disabled]),[[true,false],[false,false],[true,true]]);
assert(walk(list).some(n=>n.textContent==="Walls <script>"),"layer names are literal text");
boxes()[1].checked=true;boxes()[1].dispatchEvent(new Event("change"));
assert.deepEqual(calls,[["doors",true]]);
assert.match(status.textContent,/Applying/);
widget.setProgress(47); assert.equal(progress.value,47); assert.equal(progress.hidden,false); assert.match(status.textContent,/47%/);
pendingResolve(); await new Promise(r=>setTimeout(r,0)); widget.setProgress(null);
assert.equal(boxes()[1].checked,true);assert.equal(progress.hidden,true);
assert.equal(all.checked,true);assert.equal(all.indeterminate,false,"individual changes update the aggregate checkbox");
filter.value="door";filter.dispatchEvent(new Event("input"));assert.equal(boxes().length,1);
all.checked=false;all.dispatchEvent(new Event("change"));
assert.deepEqual(calls.at(-1),["all",false],"All submits one bulk operation");
assert.equal(layers[0].visible,true,"applied layer state remains intact until preparation commits");
pendingResolve();await new Promise(r=>setTimeout(r,0));
assert.deepEqual(layers.map(l=>l.visible),[false,false,true],"All includes filtered-out layers and preserves locked layers");
assert.equal(all.checked,false);assert.equal(all.indeterminate,false);
all.checked=true;all.dispatchEvent(new Event("change"));pendingReject(Error("bulk preparation failed"));
await new Promise(r=>setTimeout(r,0));
assert.match(status.textContent,/bulk preparation failed/);assert.equal(all.checked,false,"failed bulk updates restore the applied checkbox state");
all.checked=true;all.dispatchEvent(new Event("change"));pendingResolve();await new Promise(r=>setTimeout(r,0));
assert.equal(all.checked,true);assert.equal(all.indeterminate,false);assert(layers.every(l=>l.visible));
filter.value="missing";filter.dispatchEvent(new Event("input"));assert.equal(list.textContent,"No matching layers.");
widget.refresh();assert.equal(filter.value,"");assert.equal(boxes().length,3);
boxes()[0].checked=false;boxes()[0].dispatchEvent(new Event("change"));pendingReject(Error("Surface budget exceeded"));
await new Promise(r=>setTimeout(r,0));assert.match(status.textContent,/Surface budget exceeded.*reset/);assert.equal(boxes()[0].checked,true,"failed updates show applied state");
container.querySelector("button").dispatchEvent(new Event("click"));await new Promise(r=>setTimeout(r,0));assert.equal(boxes()[1].checked,false);
assert.equal(all.checked,false);assert.equal(all.indeterminate,true,"reset restores the mixed PDF defaults");
boxes()[1].checked=true;boxes()[1].dispatchEvent(new Event("change"));
layers=[];widget.refresh();pendingReject(Error("old document"));await new Promise(r=>setTimeout(r,0));
assert.equal(status.textContent,"");assert.match(list.textContent,/no optional-content/);assert.equal(filter.disabled,true);
assert.equal(all.checked,false);assert.equal(all.indeterminate,false);assert.equal(all.disabled,true);
layers=[group("locked","Locked",true,true),{...group("print","Print only",false),usedInView:false}];widget.refresh();
assert.equal(all.disabled,true,"documents with no editable View layers disable All");
layers=[group("replacement","Replacement",true)];widget.refresh();assert.equal(all.checked,true);assert.equal(all.indeterminate,false);assert.equal(all.disabled,false);
widget.dispose();assert.equal(listener,null);widget.setProgress(90);assert.equal(container.childNodes.length,0);
const beforeDisposedToggle=calls.length;all.dispatchEvent(new Event("change"));assert.equal(calls.length,beforeDisposedToggle,"disposal removes the All listener");

// Exercise the real shared controller: radio alternatives must not leave All
// permanently mixed, otherwise the checkbox cannot be clicked to turn them off.
const hooks=registerHooks({resolve(specifier,context,next){
  return next(context.parentURL?.includes("/src/")&&/^\.\.?\//.test(specifier)&&!/\.[a-z0-9]+$/i.test(specifier)?`${specifier}.ts`:specifier,context);
}});
try {
  const {createLayerVisibilityController}=await import("../src/layerVisibility.ts");
  const {createEmptyVectorScene}=await import("../src/emptyVectorScene.ts");
  const scene=createEmptyVectorScene();
  scene.optionalContent={groups:[group("a","Choice A",true),group("b","Choice B",false),group("free","Free",false),group("locked","Locked",true,true)],
    conditions:[],order:[],radioGroups:[["a","b"]]};
  const native=createLayerVisibilityController({getScene:()=>scene,getRenderer:()=>({})});
  native.sceneChanged();
  const root=new Element(), panel=createPdfLayerControls({container:root,controller:native});
  const toggle=root.querySelector(".pdf-layers-all input");
  assert.equal(toggle.indeterminate,true);
  toggle.checked=true;toggle.dispatchEvent(new Event("change"));await new Promise(r=>setTimeout(r,0));
  assert.deepEqual(native.getLayers().map(l=>l.visible),[true,false,true,true]);
  assert.equal(toggle.checked,true);assert.equal(toggle.indeterminate,false,"radio-compatible All can be unchecked");
  toggle.checked=false;toggle.dispatchEvent(new Event("change"));await new Promise(r=>setTimeout(r,0));
  assert.deepEqual(native.getLayers().map(l=>l.visible),[false,false,false,true]);
  assert.equal(toggle.checked,false);assert.equal(toggle.indeterminate,false);
  panel.dispose();native.dispose();
} finally {hooks.deregister();}
const main=await readFile(new URL("../src/main.ts",import.meta.url),"utf8");
assert.match(main,/layerVisibility\.rendererChanged\(\)/);assert.match(main,/layerVisibility\.sceneChanged\(\)/);
assert.match(main,/createPdfLayerControls\(/);
for(const demo of ["three-example","room-overlay-demo"]){const html=await readFile(new URL(`../${demo}.html`,import.meta.url),"utf8");assert(!html.includes('id="pdf-layers"'));}
console.log("PDF layer controls passed: hierarchy, literal names, locks, filtering, progress, failures and document lifecycle.");
