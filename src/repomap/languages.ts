// 语言配置:扩展名 → grammar + 各语言的定义节点类型。
// defNodes 的 value 是"取名字的 field 名":"name" 走 childForFieldName(name),
// "type" 走 childForFieldName(type)(Rust impl 块),"declarator" 表示要下钻到
// variable_declarator 才能拿到名字(TS/JS 的 const foo = () => {}),
// "spec" 表示下钻到 type_spec(Go 的 type 声明)。
export interface LangDef {
  grammar: string;
  extensions: string[];
  defNodes: Record<string, "name" | "type" | "declarator" | "spec">;
}

const TS_FAMILY: LangDef = {
  grammar: "tree-sitter-typescript.wasm",
  extensions: [".ts", ".mts", ".cts"],
  defNodes: {
    class_declaration: "name",
    abstract_class_declaration: "name",
    function_declaration: "name",
    method_definition: "name",
    interface_declaration: "name",
    type_alias_declaration: "name",
    enum_declaration: "name",
    lexical_declaration: "declarator",
  },
};

export const LANGUAGES: LangDef[] = [
  TS_FAMILY,
  { ...TS_FAMILY, grammar: "tree-sitter-tsx.wasm", extensions: [".tsx"] },
  {
    grammar: "tree-sitter-javascript.wasm",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    defNodes: {
      class_declaration: "name",
      abstract_class_declaration: "name",
      function_declaration: "name",
      method_definition: "name",
      lexical_declaration: "declarator",
    },
  },
  {
    grammar: "tree-sitter-python.wasm",
    extensions: [".py"],
    defNodes: {
      class_definition: "name",
      function_definition: "name",
    },
  },
  {
    grammar: "tree-sitter-go.wasm",
    extensions: [".go"],
    defNodes: {
      function_declaration: "name",
      method_declaration: "name",
      type_declaration: "spec",
    },
  },
  {
    grammar: "tree-sitter-rust.wasm",
    extensions: [".rs"],
    defNodes: {
      function_item: "name",
      struct_item: "name",
      enum_item: "name",
      trait_item: "name",
      mod_item: "name",
      impl_item: "type",
    },
  },
  {
    grammar: "tree-sitter-java.wasm",
    extensions: [".java"],
    defNodes: {
      class_declaration: "name",
      interface_declaration: "name",
      enum_declaration: "name",
      record_declaration: "name",
      method_declaration: "name",
    },
  },
];

// 扩展名 → 语言定义(启动时建一次索引)。
const EXT_INDEX: Map<string, LangDef> = (() => {
  const m = new Map<string, LangDef>();
  for (const lang of LANGUAGES) for (const ext of lang.extensions) m.set(ext, lang);
  return m;
})();

export function langForFile(relPath: string): LangDef | undefined {
  const dot = relPath.lastIndexOf(".");
  if (dot < 0) return undefined;
  return EXT_INDEX.get(relPath.slice(dot).toLowerCase());
}
