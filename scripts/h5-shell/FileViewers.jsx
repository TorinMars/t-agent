import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import { t } from './common.jsx';
import { TABLE_ROWS, parseDelimited, separatorOf } from './file-formats.mjs';

// The file sheet's views that are not lines of text (Design.jsx): an image, a PDF, an audio or video file, the table of a CSV / TSV file and the
// preview of an HTML file. The text views (code, JSON, sources) are drawn by file-view.mjs renderText. `onFailed(code)` tells the sheet that the file
// could not be shown (the code of the server's answer when it can be read, else 'MEDIA_ERROR'); the sheet then shows the note instead.

// Bytes for the person: 980 B, 12.4 KB, 3.1 MB.
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
// The size of what the page downloaded from `src`, when the browser knows it (Resource Timing; same origin).
function downloadedSize(src) {
  try {
    const url = new URL(src, location.href).href;
    const entry = performance.getEntriesByName(url).pop();
    return entry ? entry.decodedBodySize || entry.encodedBodySize || 0 : 0;
  } catch { return 0; }
}
// Why an address does not load: the error code of the server's JSON answer (an <img> or <video> cannot say).
async function failureOf(src) {
  try {
    const res = await fetch(src, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (res.ok) return 'MEDIA_ERROR'; // it loads, but the browser cannot show it
    const data = await res.json().catch(() => null);
    return (data && data.error) || `HTTP ${res.status}`;
  } catch { return 'NETWORK'; }
}

const FILL = { flex: '1 1 auto', minHeight: 0, minWidth: 0 };
// Behind a transparent image: a light and dark checkerboard, so both dark and light pictures show.
const CHECKERBOARD = {
  backgroundColor: '#2b2b2b',
  backgroundImage: 'linear-gradient(45deg, #3a3a3a 25%, transparent 25%), linear-gradient(-45deg, #3a3a3a 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #3a3a3a 75%), linear-gradient(-45deg, transparent 75%, #3a3a3a 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
};

// An image, fitted into the sheet (never larger than its own size), with its pixel size and file size under it. A tap, a click or Enter shows it full
// screen (ImageViewer.jsx) at fit.
export function ImageView({ src, name, onView, onFailed }) {
  const [info, setInfo] = useState(null);
  useEffect(() => { setInfo(null); }, [src]);
  const loaded = event => {
    const img = event.currentTarget;
    setInfo({ w: img.naturalWidth, h: img.naturalHeight, bytes: downloadedSize(src) });
  };
  const failed = async () => onFailed(await failureOf(src));
  const facts = info ? [info.w && info.h ? `${info.w} × ${info.h}` : '', formatBytes(info.bytes)].filter(Boolean).join(' · ') : '';
  return (
    <Box className="h5-design-body h5-file-viewer" data-kind="image" sx={{ ...FILL, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, overflow: 'auto', overscrollBehavior: 'contain', p: 2 }}>
      <Box sx={{ flex: '1 1 auto', minHeight: 0, alignSelf: 'stretch', position: 'relative' }}>
        <ButtonBase
          id="h5-file-image-open" focusRipple aria-label={t('View image')} title={t('View image')} aria-haspopup="dialog" onClick={() => onView({ kind: 'img', src, alt: name, name, download: src })}
          sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 1, cursor: 'zoom-in', '&.Mui-focusVisible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 } }}
        >
          <Box component="img" id="h5-file-image" src={src} alt={name} draggable={false} onLoad={loaded} onError={failed}
            sx={{ ...CHECKERBOARD, display: 'block', maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' }}
          />
        </ButtonBase>
      </Box>
      <Box id="h5-file-image-info" component="div" translate="no" sx={{ flex: '0 0 auto', minHeight: 18, fontSize: 12, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>{facts}</Box>
    </Box>
  );
}

// A PDF: the browser's own PDF viewer in a frame (no sandbox: Chrome does not show a sandboxed PDF; the raw read sends no CSP sandbox for a PDF for
// that reason). The sheet's toolbar has "Open in new tab" too, for phones whose browser shows only the first page in a frame.
export function PdfView({ src, name }) {
  return (
    <Box className="h5-file-viewer" data-kind="pdf" sx={{ ...FILL, display: 'flex', bgcolor: '#525659' }}>
      <Box component="iframe" id="h5-file-pdf" src={src} title={name} sx={{ flex: '1 1 auto', border: 0, width: '100%', height: '100%', display: 'block' }} />
    </Box>
  );
}

// An audio or a video file, played by the browser (Range reads let it seek). A file whose format the browser cannot play shows the note instead.
export function MediaView({ kind, src, name, onFailed }) {
  const failed = async event => {
    const media = event.currentTarget;
    const decoding = media && media.error && (media.error.code === 3 || media.error.code === 4); // MEDIA_ERR_DECODE, MEDIA_ERR_SRC_NOT_SUPPORTED
    const code = await failureOf(src);
    onFailed(decoding && code === 'MEDIA_ERROR' ? 'MEDIA_ERROR' : code);
  };
  if (kind === 'audio') {
    return (
      <Box className="h5-design-body h5-file-viewer" data-kind="audio" sx={{ ...FILL, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 3 }}>
        <Box component="audio" id="h5-file-audio" controls preload="metadata" src={src} aria-label={name} onError={failed} sx={{ width: '100%', maxWidth: 560 }} />
      </Box>
    );
  }
  return (
    <Box className="h5-file-viewer" data-kind="video" sx={{ ...FILL, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: '#000' }}>
      <Box component="video" id="h5-file-video" controls playsInline preload="metadata" src={src} aria-label={name} onError={failed} sx={{ display: 'block', maxWidth: '100%', maxHeight: '100%' }} />
    </Box>
  );
}

// The table of a CSV / TSV file: the first row is the header (it stays at the top while the table scrolls), then at most TABLE_ROWS rows. Long tables
// and wide ones scroll inside the sheet. The cells are the file's own text, so the translation layer leaves them alone.
export function CsvTable({ content, path }) {
  const { rows, total } = useMemo(() => parseDelimited(content, separatorOf(path), TABLE_ROWS + 1), [content, path]);
  const columns = rows.reduce((most, row) => Math.max(most, row.length), 0);
  const [head, ...body] = rows;
  const cell = { px: 1.25, py: 0.5, borderBottom: 1, borderRight: 1, borderColor: 'divider', textAlign: 'left', verticalAlign: 'top', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: 360, minWidth: 48 };
  const pad = row => (row.length < columns ? [...row, ...Array(columns - row.length).fill('')] : row);
  const more = total - 1 - body.length;
  return (
    <Box className="h5-design-body h5-file-viewer" data-kind="csv" sx={{ ...FILL, overflow: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}>
      {rows.length ? (
        <Box component="table" id="h5-file-table" translate="no" sx={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 13, lineHeight: 1.45, fontFamily: 'ui-monospace, Menlo, monospace', minWidth: '100%' }}>
          <thead>
            <tr>{pad(head).map((text, i) => <Box component="th" key={i} scope="col" sx={{ ...cell, position: 'sticky', top: 0, zIndex: 1, bgcolor: '#21262d', fontWeight: 600 }}>{text}</Box>)}</tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <Box component="tr" key={r} sx={{ '&:nth-of-type(even)': { bgcolor: '#161b22' } }}>
                {pad(row).map((text, i) => <Box component="td" key={i} sx={cell}>{text}</Box>)}
              </Box>
            ))}
          </tbody>
        </Box>
      ) : null}
      {more > 0 ? <Box id="h5-file-table-more" role="note" sx={{ p: 1.5, fontSize: 12, color: 'text.secondary' }}>{t(`Showing the first ${body.length} of ${total - 1} rows`)}</Box> : null}
    </Box>
  );
}

// The preview of an HTML file: drawn in a frame with an empty sandbox (no scripts, no forms, no same-origin access) and a CSP that loads nothing from
// this server (only inline styles, data: images and web images / styles / fonts), so the page cannot call the Client's API.
const PREVIEW_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: https:; style-src \'unsafe-inline\' https:; font-src data: https:; media-src data: https:">';
// The CSP goes after a <!doctype>, which must stay first (else the page is drawn in quirks mode); the parser puts it into <head> either way.
export const withPreviewCsp = content => {
  const text = String(content);
  const doctype = text.match(/^\uFEFF?\s*<!doctype[^>]*>/i);
  return doctype ? `${doctype[0]}${PREVIEW_CSP}${text.slice(doctype[0].length)}` : `${PREVIEW_CSP}${text}`;
};
export function HtmlPreview({ content, name }) {
  return (
    <Box className="h5-file-viewer" data-kind="html" sx={{ ...FILL, display: 'flex', bgcolor: '#fff' }}>
      <Box component="iframe" id="h5-file-html" sandbox="" referrerPolicy="no-referrer" srcDoc={withPreviewCsp(content)} title={name} sx={{ flex: '1 1 auto', border: 0, width: '100%', height: '100%', display: 'block', bgcolor: '#fff' }} />
    </Box>
  );
}
