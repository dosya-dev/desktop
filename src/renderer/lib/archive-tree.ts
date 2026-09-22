// apps/web/src/lib/archive-tree.ts
//
// The archive index arrives FLAT - one row per entry, each carrying its full
// path - because that is the cheapest thing for the API to cache and the
// smallest thing to send. The pane needs a tree, and this is the only place
// that conversion happens.
//
// Kept free of React and fetch so the awkward parts (implied directories,
// ordering, hostile names) can be tested against plain data.

/** One row of `GET /api/files/:id/archive`. */
export interface ArchiveEntry {
    /** Central-directory index. The ONLY way an entry is addressed. */
    i: number;
    name: string;
    size: number;
    csize: number;
    method: number;
    dir: boolean;
    encrypted: boolean;
    mtime: number | null;
}

export interface TreeNode {
    kind: 'dir' | 'file';
    name: string;
    /** Present on files only; the index the entry endpoint takes. */
    index: number | null;
    size: number;
    method: number;
    encrypted: boolean;
    mtime: number | null;
    children: TreeNode[];
    /** Directories only: everything beneath, for the row's summary. */
    totalBytes: number;
    fileCount: number;
}

/**
 * One path segment, cleaned for DISPLAY.
 *
 * This is the only place archive entry names are neutralised. The index
 * endpoint hands them over exactly as the zip stored them - the server decodes
 * the charset and nothing else - so nothing upstream has cleaned them.
 *
 * Safety does not rest on this: the server addresses entries by
 * central-directory INDEX, so a name can never reach a file. What this stops is
 * a hostile or careless archive drawing a tree that lies about where something
 * sits, or rendering a row that looks blank.
 */
function safeSegment(raw: string): string {
    // Stripping control characters is the point: a name made only of them
    // would render as a blank row.
    //
    // The bidi controls and directional marks go with them, for a sharper
    // reason: they change what a name READS as without changing what it is.
    // An entry stored as "invoice\u202Egnp.exe" draws as "invoicexe.png" in
    // every client - the classic right-to-left-override spoof - and the name
    // does not stop at the row: it reaches the desktop save dialog's
    // defaultPath and the `filename*=UTF-8''` parameter browsers prefer over
    // the plain one. A tree that lies is what this function exists to stop,
    // and a name that lies is the same bug one level down.
    // eslint-disable-next-line no-control-regex
    const cleaned = raw.replace(/[\x00-\x1f\x7f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
    if (cleaned === '' || cleaned === '.' || cleaned === '..') return '';
    return cleaned;
}

function splitPath(name: string): string[] {
    // Separators are normalised on the whole name BEFORE splitting. Doing it
    // per-segment cannot split anything - the split already happened - so a
    // zip written on Windows produced one node literally named "a/b/c.txt".
    return name.replace(/\\/g, '/').split('/').map(safeSegment).filter((s) => s.length > 0);
}

function newDir(name: string): TreeNode {
    return {
        kind: 'dir', name, index: null, size: 0, method: 0, encrypted: false,
        mtime: null, children: [], totalBytes: 0, fileCount: 0,
    };
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
    nodes.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    for (const n of nodes) if (n.children.length > 0) sortNodes(n.children);
    return nodes;
}

/** Roll each directory's byte total and file count up from its descendants. */
function summarise(node: TreeNode): void {
    if (node.kind === 'file') return;
    let bytes = 0;
    let files = 0;
    for (const child of node.children) {
        summarise(child);
        if (child.kind === 'file') { bytes += child.size; files += 1; }
        else { bytes += child.totalBytes; files += child.fileCount; }
    }
    node.totalBytes = bytes;
    node.fileCount = files;
}

export function buildArchiveTree(entries: ArchiveEntry[]): TreeNode[] {
    const roots: TreeNode[] = [];
    const dirs = new Map<string, TreeNode>();

    /** Find or create the directory at `segments`, creating parents as needed. */
    function dirAt(segments: string[]): TreeNode | null {
        let siblings = roots;
        let node: TreeNode | null = null;
        let key = '';
        for (const seg of segments) {
            key = key === '' ? seg : `${key}/${seg}`;
            let found = dirs.get(key);
            if (!found) {
                found = newDir(seg);
                dirs.set(key, found);
                siblings.push(found);
            }
            node = found;
            siblings = found.children;
        }
        return node;
    }

    for (const e of entries) {
        const segments = splitPath(e.name);
        if (segments.length === 0) continue;

        if (e.dir) {
            dirAt(segments);
            continue;
        }

        const leafName = segments[segments.length - 1]!;
        const parent = dirAt(segments.slice(0, -1));
        const leaf: TreeNode = {
            kind: 'file', name: leafName, index: e.i, size: e.size,
            method: e.method, encrypted: e.encrypted, mtime: e.mtime,
            children: [], totalBytes: e.size, fileCount: 1,
        };
        (parent ? parent.children : roots).push(leaf);
    }

    for (const r of roots) summarise(r);
    return sortNodes(roots);
}
