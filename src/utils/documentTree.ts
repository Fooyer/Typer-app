import type { AtelierDocNameEntry } from "../platform/types";

export interface TreeFolder {
  type: "folder";
  name: string;
  path: string;
  children: TreeNode[];
}

export interface TreeFile {
  type: "file";
  name: string;
  docName: string;
}

export type TreeNode = TreeFolder | TreeFile;

/** Classes are packaged via dot segments (Demo.Utils.Helper.cls -> Demo/Utils/Helper.cls); CSP files use real
 * "/" paths; routines (.mac/.int/.inc) have no InterSystems-defined nesting, so they stay flat. */
export function splitSegments(docName: string): string[] {
  if (docName.toLowerCase().endsWith(".cls")) {
    const withoutExt = docName.slice(0, -4);
    const parts = withoutExt.split(".");
    const className = parts.pop();
    return className ? [...parts, `${className}.cls`] : [docName];
  }
  if (docName.includes("/")) {
    return docName.split("/");
  }
  return [docName];
}

export function buildDocumentTree(docs: AtelierDocNameEntry[]): TreeNode[] {
  const root: TreeFolder = { type: "folder", name: "", path: "", children: [] };
  // Looking up a folder by scanning `current.children` (as before) is O(siblings) per segment, and a
  // package with thousands of same-level classes/subfolders made that quadratic. A path is unique
  // across the whole tree (it's just the chain of segment names from the root), so a single global
  // map gives the same merge behavior as the old scoped-by-parent lookup in O(1) instead.
  const folderIndex = new Map<string, TreeFolder>([["", root]]);

  for (const doc of docs) {
    const segments = splitSegments(doc.name);
    let current = root;
    let currentPath = "";
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      currentPath = currentPath ? `${currentPath}.${segment}` : segment;
      let folder = folderIndex.get(currentPath);
      if (!folder) {
        folder = { type: "folder", name: segment, path: currentPath, children: [] };
        folderIndex.set(currentPath, folder);
        current.children.push(folder);
      }
      current = folder;
    }
    current.children.push({ type: "file", name: segments[segments.length - 1], docName: doc.name });
  }

  sortTree(root);
  return root.children;
}

/** Key uniquely identifying a node within a tree, used for selection tracking. */
export function nodeKey(node: TreeNode): string {
  return node.type === "file" ? `f:${node.docName}` : `d:${node.path}`;
}

/** Recursively collects every `.cls` file under the given nodes (a lone file node is included as-is). */
export function collectClassFiles(nodes: TreeNode[]): TreeFile[] {
  const result: TreeFile[] = [];
  const visit = (node: TreeNode) => {
    if (node.type === "file") {
      if (node.docName.toLowerCase().endsWith(".cls")) result.push(node);
    } else {
      node.children.forEach(visit);
    }
  };
  nodes.forEach(visit);
  return result;
}

function sortTree(folder: TreeFolder) {
  folder.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of folder.children) {
    if (child.type === "folder") sortTree(child);
  }
}

/** Recursively gathers every file leaf under a node (a single file yields itself). */
export function collectFiles(node: TreeNode, out: TreeFile[] = []): TreeFile[] {
  if (node.type === "file") out.push(node);
  else for (const child of node.children) collectFiles(child, out);
  return out;
}

/** A file can be dragged into/out of package folders only if its name actually carries the kind of
 * nesting a folder represents (dot-segmented class, or a real "/" path) — flat routines have no
 * package concept, so there's nowhere to move them to. */
export function canReparent(node: TreeNode): boolean {
  if (node.type === "folder") return true;
  return node.docName.toLowerCase().endsWith(".cls") || node.docName.includes("/");
}

function pathSegments(path: string): string[] {
  return path ? path.split(".") : [];
}

/** The dot-joined parent path of a doc's immediate containing folder — matches the `path` convention
 * used for TreeFolder nodes (see buildDocumentTree), regardless of the doc's own separator style. */
export function docParentPath(docName: string): string {
  return splitSegments(docName).slice(0, -1).join(".");
}

/** The dot-joined path of a folder's own parent (empty string if it's already top-level). */
export function parentPath(path: string): string {
  const segments = pathSegments(path);
  segments.pop();
  return segments.join(".");
}

/** Rebuilds a doc name as if the segment chain it currently sits under (`oldPrefixPath`) were replaced
 * by `newPrefixPath`, preserving whatever comes after and the doc's own segment separator (dots for
 * classes, "/" for CSP paths). Used for both renaming a folder in place and drag-and-drop moves —
 * both are just "swap this leading prefix for that one" on every file underneath. */
export function rehomeDocName(
  docName: string,
  oldPrefixPath: string,
  newPrefixPath: string,
): string {
  const segments = splitSegments(docName);
  const oldPrefixSegments = pathSegments(oldPrefixPath);
  const relative = segments.slice(oldPrefixSegments.length);
  const newSegments = [...pathSegments(newPrefixPath), ...relative];
  const separator = docName.toLowerCase().endsWith(".cls")
    ? "."
    : docName.includes("/")
      ? "/"
      : ".";
  return newSegments.join(separator);
}
