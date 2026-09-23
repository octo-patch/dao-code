import { describe, it, expect, beforeAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { extractFile } from "./extract.js";
import { langForFile } from "./languages.js";

// wasm 加载在 vitest(node)下走 createRequire 路径;若环境异常(缺 node_modules)跳过而不是挂死。
let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "repomap-extract-"));
});

async function extract(source: string, fileName: string) {
  const abs = path.join(tmpDir, fileName);
  await fs.writeFile(abs, source);
  const lang = langForFile(fileName);
  if (!lang) throw new Error(`no lang for ${fileName}`);
  return extractFile(abs, lang);
}

describe("extractFile", () => {
  it("TS:类/接口/类型/函数/方法/枚举/箭头函数,过滤纯常量", async () => {
    const r = await extract(`
import { foo } from "./other";
export interface Config { a: number; }
export class Service {
  method(arg: string): void {}
}
export function standalone(a: number): boolean { return true; }
const arrow = (n: number) => n + 1;
const plain = 123;
enum Color { Red }
`, "a.ts");
    expect(r).not.toBeNull();
    const names = r!.defs.map((d) => d.name);
    expect(names).toContain("Config");
    expect(names).toContain("Service");
    expect(names).toContain("method");
    expect(names).toContain("standalone");
    expect(names).toContain("arrow");
    expect(names).toContain("Color");
    expect(names).not.toContain("plain");
    // 相对 import 源被收集
    expect(r!.importSources).toContain("./other");
    // named import 的符号名进入 refs
    expect(r!.refs).toContain("foo");
  });

  it("TS:签名跨行时保留多行(到 body 起始行)", async () => {
    const r = await extract(`
export function create(
  mainModel: string,
  editFormat: string,
): Coder {
  return null as any;
}
`, "b.ts");
    expect(r).not.toBeNull();
    const def = r!.defs.find((d) => d.name === "create")!;
    expect(def.signature).toContain("mainModel: string");
    expect(def.signature).not.toContain("return");
  });

  it("Python:class/def + import 名", async () => {
    const r = await extract(`
import os.path
from typing import List

class Dog:
    def bark(self):
        print("woof")

def add(a, b):
    return a + b
`, "a.py");
    expect(r).not.toBeNull();
    const names = r!.defs.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["Dog", "bark", "add"]));
    expect(r!.refs).toContain("List");
  });

  it("Go:func/method/type + import 末段", async () => {
    const r = await extract(`
package main

import "github.com/x/y/util"

type Server struct {
  Port int
}

func NewServer() *Server { return nil }
func (s *Server) Run() error { return nil }
`, "a.go");
    expect(r).not.toBeNull();
    const names = r!.defs.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["Server", "NewServer", "Run"]));
    expect(r!.refs).toContain("util");
  });

  it("Rust:struct/trait/impl/fn + use 段", async () => {
    const r = await extract(`
use std::collections::HashMap;

pub struct Cache { inner: HashMap<String, String> }

pub trait Store {
    fn get(&self, k: &str) -> Option<String>;
}

impl Cache {
    pub fn new() -> Self { todo!() }
}

pub fn build() -> Cache { todo!() }
`, "a.rs");
    expect(r).not.toBeNull();
    const names = r!.defs.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["Cache", "Store", "new", "build"]));
    expect(r!.refs).toContain("HashMap");
  });

  it("Java:class/interface/enum/method + import 末段", async () => {
    const r = await extract(`
import java.util.List;

public class Sample {
  public void run() {}
}

interface Listener { void onEvent(int x); }
enum Status { OK }
`, "A.java");
    expect(r).not.toBeNull();
    const names = r!.defs.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["Sample", "run", "Listener", "Status"]));
    expect(r!.refs).toContain("List");
  });

  it("TSX 走独立 grammar", async () => {
    const r = await extract(`
export function App(props: { title: string }) {
  return null;
}
`, "a.tsx");
    expect(r).not.toBeNull();
    expect(r!.defs.map((d) => d.name)).toContain("App");
  });

  it("不支持的语言返回 undefined 的 lang def", () => {
    expect(langForFile("a.txt")).toBeUndefined();
    expect(langForFile("README.md")).toBeUndefined();
    expect(langForFile("src/x.ts")).toBeDefined();
  });
});
