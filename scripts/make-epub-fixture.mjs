import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 } from "node:zlib";

/**
 * Writes a minimal but VALID epub for the reader spec.
 *
 * Built by hand rather than committed as a binary blob so the fixture is
 * reviewable: an epub is a zip whose first entry must be an uncompressed
 * `mimetype`, and getting that wrong is the classic way to produce a file every
 * reader rejects.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const files = [
  { name: "mimetype", body: "application/epub+zip", store: true },
  {
    name: "META-INF/container.xml",
    body: `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  },
  {
    name: "OEBPS/content.opf",
    body: `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:dosya-test-book</dc:identifier>
    <dc:title>The Dosya Test Book</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`,
  },
  {
    name: "OEBPS/nav.xhtml",
    body: `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head>
<body><nav epub:type="toc"><ol>
  <li><a href="chapter1.xhtml">First Chapter</a></li>
  <li><a href="chapter2.xhtml">Second Chapter</a></li>
</ol></nav></body></html>`,
  },
  {
    name: "OEBPS/chapter1.xhtml",
    body: `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>First Chapter</title></head>
<body><h1>First Chapter</h1><p>Chapter one of the Dosya test book.</p></body></html>`,
  },
  {
    name: "OEBPS/chapter2.xhtml",
    body: `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Second Chapter</title></head>
<body><h1>Second Chapter</h1><p>Chapter two of the Dosya test book.</p></body></html>`,
  },
];

const chunks = [];
const central = [];
let offset = 0;

for (const f of files) {
  const nameBuf = Buffer.from(f.name, "utf8");
  const raw = Buffer.from(f.body, "utf8");
  const data = f.store ? raw : deflateRawSync(raw);
  const method = f.store ? 0 : 8;
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  chunks.push(local, nameBuf, data);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(raw.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(offset, 42);
  central.push(cd, nameBuf);

  offset += local.length + nameBuf.length + data.length;
}

const cdBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cdBuf.length, 12);
end.writeUInt32LE(offset, 16);

const epub = Buffer.concat([...chunks, cdBuf, end]);
mkdirSync(join(root, "tests/fixtures"), { recursive: true });
writeFileSync(join(root, "tests/fixtures/test-book.epub"), epub);
console.log(`test-book.epub written (${epub.length} bytes)`);
