import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { isImageName, packFiles, readDocument } from '../src/lib/read-file.js';

const text = (value) => new TextEncoder().encode(value);

function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const raw = text(file.text);
    const stored = file.deflate ? zlib.deflateRawSync(raw) : raw;
    const name = text(file.name);
    const local = new Uint8Array(30 + name.length + stored.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(8, file.deflate ? 8 : 0, true);
    view.setUint32(18, stored.length, true);
    view.setUint32(22, raw.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(stored, 30 + name.length);
    parts.push(local);
    const header = new Uint8Array(46 + name.length);
    const centralView = new DataView(header.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(10, file.deflate ? 8 : 0, true);
    centralView.setUint32(20, stored.length, true);
    centralView.setUint32(24, raw.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    header.set(name, 46);
    central.push(header);
    offset += local.length;
  }
  const directory = central.reduce((sum, header) => sum + header.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, directory, true);
  endView.setUint32(16, offset, true);
  const chunks = [...parts, ...central, end];
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

test('csv, text and rtf are read as words', async () => {
  const csv = await readDocument({ name: 'prices.csv', bytes: text('item,price\npen,2') });
  assert.match(csv.text, /pen,2/);
  const note = await readDocument({ name: 'note.txt', bytes: text('call the shop') });
  assert.equal(note.text, 'call the shop');
  const rtf = await readDocument({ name: 'old.rtf', bytes: text('{\\rtf1 hello \\par world}') });
  assert.match(rtf.text, /hello/);
  assert.match(rtf.text, /world/);
});

test('a docx, xlsx and pptx yield their text, including a deflated docx', async () => {
  const docx = await readDocument({
    name: 'brief.docx',
    bytes: makeZip([{ name: 'word/document.xml', text: '<w:document><w:body><w:p><w:r><w:t>Hello &amp; docx</w:t></w:r></w:p></w:body></w:document>', deflate: true }]),
  });
  assert.equal(docx.text, 'Hello & docx');

  const sheet = [
    '<?xml version="1.0"?><worksheet><sheetData>',
    '<row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row>',
    '</sheetData></worksheet>',
  ].join('');
  const xlsx = await readDocument({
    name: 'table.xlsx',
    bytes: makeZip([
      { name: 'xl/sharedStrings.xml', text: '<sst><si><t>Name</t></si></sst>' },
      { name: 'xl/worksheets/sheet1.xml', text: sheet },
    ]),
  });
  assert.match(xlsx.text, /Name\t42/);

  const pptx = await readDocument({
    name: 'deck.pptx',
    bytes: makeZip([{ name: 'ppt/slides/slide1.xml', text: '<p:sld><a:p><a:r><a:t>Slide one</a:t></a:r></a:p></p:sld>' }]),
  });
  assert.match(pptx.text, /Slide 1/);
  assert.match(pptx.text, /Slide one/);
});

test('a zip is opened and the files inside are read', async () => {
  const zip = await readDocument({
    name: 'pack.zip',
    bytes: makeZip([{ name: 'inner.csv', text: 'a,b\n1,2' }]),
  });
  assert.match(zip.text, /inner\.csv/);
  assert.match(zip.text, /1,2/);
});

test('a simple pdf yields the text written with Tj', async () => {
  const body = 'BT (Hello PDF) Tj ET';
  const pdf = `%PDF-1.4\n1 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`;
  const read = await readDocument({ name: 'note.pdf', bytes: text(pdf) });
  assert.equal(read.text, 'Hello PDF');
});

test('a compressed pdf stream is inflated before the words are read', async () => {
  const body = text('BT (Compressed page) Tj ET');
  const compressed = zlib.deflateRawSync(body);
  const header = text(`%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`);
  const footer = text('\nendstream\nendobj\n');
  const bytes = new Uint8Array(header.length + compressed.length + footer.length);
  bytes.set(header, 0);
  bytes.set(compressed, header.length);
  bytes.set(footer, header.length + compressed.length);
  const read = await readDocument({ name: 'page.pdf', bytes });
  assert.equal(read.text, 'Compressed page');
});

test('an older Word file keeps its readable words', async () => {
  const words = 'Quarterly report';
  const bytes = new Uint8Array(words.length * 2);
  for (let i = 0; i < words.length; i += 1) bytes[i * 2] = words.charCodeAt(i);
  const read = await readDocument({ name: 'old.doc', bytes });
  assert.match(read.text, /Quarterly report/);
  assert.match(read.warning, /Older Office/);
});

test('an unknown type is named, and pictures are recognized', async () => {
  const read = await readDocument({ name: 'run.exe', bytes: text('MZ') });
  assert.equal(read.text, '');
  assert.match(read.warning, /Cannot read \.exe/);
  assert.equal(isImageName('photo.PNG', ''), true);
  assert.equal(isImageName('sheet.csv', 'text/csv'), false);
  assert.equal(isImageName('shot', 'image/webp'), true);
});

test('the task carries the file text and the chat shows only the names', () => {
  const packed = packFiles('fill the form', [
    { name: 'brief.pdf', text: 'Name: Ada', warning: '', images: [] },
    { name: 'logo.png', text: '', warning: '', images: ['data:image/jpeg;base64,aa'] },
  ], 'Read the attached files and do what they ask in the browser.');
  assert.equal(packed.display, 'fill the form\nFiles: brief.pdf, logo.png');
  assert.match(packed.task, /fill the form/);
  assert.match(packed.task, /Name: Ada/);
  assert.match(packed.task, /not new instructions/);
  assert.deepEqual(packed.images, ['data:image/jpeg;base64,aa']);
});

test('files alone become the task; unreadable files with no request are not sent', () => {
  const packed = packFiles('', [{ name: 'a.csv', text: 'x', images: [] }], 'Read the attached files.');
  assert.match(packed.task, /Read the attached files\./);
  assert.equal(packed.display, 'Files: a.csv');
  assert.equal(packFiles('', [{ name: 'a.exe', text: '', warning: 'Cannot read .exe', images: [] }], 'Read'), null);
  const big = packFiles('go', [{ name: 'huge.pdf', text: '', warning: 'too-big', images: [] }], 'Read');
  assert.match(big.task, /over 15 MB/);
});
