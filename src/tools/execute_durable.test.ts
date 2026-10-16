import {describe,it,expect} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {z} from "zod";
import {DurableStore} from "../session/durable_store.js";
import {executeToolCalls} from "./execute.js";
import {ToolRegistry} from "./registry.js";
import {defineTool} from "./types.js";
import type {ApprovalGate} from "../approval/types.js";
const gate:ApprovalGate={decide:()=>"allow",decideAsync:async()=>"allow",requestBatch:async()=>new Map()};
const call={id:"write",type:"function" as const,function:{name:"Write",arguments:"{}"}};
function fixture(){
 const dir=mkdtempSync(path.join(tmpdir(),"dao-tool-journal-"));
 const store=new DurableStore(dir,"test",dir,{current:()=>({host:"test",boot:"boot",pid:1,start:"start"}),alive:()=>false});
 let count=0;const registry=new ToolRegistry();registry.register(defineTool({name:"Write",description:"test",capability:"write",approval:"auto",schema:z.object({}),handler:async()=>{count++;return "changed";}}));
 return {store,registry,ctx:{workspaceRoot:dir,durableStore:store},count:()=>count,close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
describe("durable tool dispatch",()=>{
 it("never executes a completed tool ID twice",async()=>{
  const f=fixture();try{const first=await executeToolCalls([call],f.registry,f.ctx,gate);const second=await executeToolCalls([call],f.registry,f.ctx,gate);expect(second).toEqual(first);expect(f.count()).toBe(1);}finally{f.close();}
 });
 it("stops before side effects when intent persistence fails",async()=>{
  const f=fixture();try{f.store.db.exec("PRAGMA query_only=ON");await expect(executeToolCalls([call],f.registry,f.ctx,gate)).rejects.toThrow();expect(f.count()).toBe(0);}finally{f.store.db.exec("PRAGMA query_only=OFF");f.close();}
 });
 it("journals PreToolUse before the hook can perform side effects",async()=>{
  const f=fixture();try{
   const ctx={...f.ctx,preToolHook:async()=>{expect(f.store.toolRecords().some(r=>r.id==="write:prehook"&&r.state==="started")).toBe(true);throw Error("crash during hook");}};
   await expect(executeToolCalls([call],f.registry,ctx,gate)).rejects.toThrow(/crash/);expect(f.count()).toBe(0);
   f.store.markInterruptedTools();await expect(executeToolCalls([call],f.registry,f.ctx,gate)).rejects.toThrow(/未知/);
  }finally{f.close();}
 });
});
