import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import { api, errorText, t } from './common.jsx';
import { Fmt, ViewFrame, shortDate, tf } from './Learn.jsx';

// The Mistakes page of Learn and the mistake reports ("Mistakes" and "Mistake reports" in docs/design/learn-english-page.md; the server's
// /api/learn/mistakes and /api/learn/reports, docs/design/learn-english.md). Part of the Learn chunk (screen-learn.jsx).
// - Mistakes: the "Why do I get these wrong?" card (how many mistakes since the last report, Analyze, Last report, All reports; without a usable
//   translation model it says so and the list still works), then every wrong answer, newest first: what was asked for, what the person wrote, the
//   mode chip and the tag chip of the page's checker (learn-grade.mjs `mistakeTag`).
// - A report: the stretch it covers, the summary, the kinds with their counts as bars, and per main kind the cause, what to do and the cards behind
//   it; "Practise these N cards" starts a session with them (found by text on this engine, POST /api/learn/cards/find).
// The text a model wrote is user content (translate="no"): it is already in the language the person reads.

// The names of the modes as the home shows them (exact dictionary keys).
const MODE_LABELS = { spell: 'Spell the word', build: 'Build the sentence', dictation: 'Dictation', say: 'Say it', fill: 'Fill the gap', review: 'Review', mistakes: 'Review' };
export const TAG_LABELS = {
  'letter-order': 'letter order', 'double-letter': 'double letter', 'missing-letter': 'missing letter', 'extra-letter': 'extra letter',
  'wrong-letter': 'wrong letter', spelling: 'spelling', article: 'article', plural: 'plural', tense: 'tense', 'verb-form': 'verb form',
  'word-order': 'word order', 'missing-word': 'missing word', 'extra-word': 'extra word', 'wrong-word': 'wrong word', listening: 'listening',
  pronunciation: 'pronunciation', unknown: "didn't know", other: 'other',
};
const KIND_LABELS = {
  spelling: 'Spelling', tense: 'Tense', 'verb-form': 'Verb forms', article: 'Articles', plural: 'Plurals', 'word-order': 'Word order',
  words: 'Missing or wrong words', listening: 'Listening', pronunciation: 'Pronunciation', unknown: "Didn't know", other: 'Other',
};
const DAY = 24 * 60 * 60 * 1000;
const dayStart = time => { const date = new Date(time); date.setHours(0, 0, 0, 0); return date.getTime(); };
// "today", "yesterday" or the short date of the page (11-18).
function when(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const days = Math.round((dayStart(Date.now()) - dayStart(time)) / DAY);
  if (days === 0) return t('today');
  if (days === 1) return t('yesterday');
  return shortDate(iso);
}
const range = report => `${report.covers_from ? shortDate(report.covers_from) : t('the start')} – ${shortDate(report.covers_until)}`;

// ── Mistakes ──

export function MistakesView({ frame, ui, open, openTranslator }) {
  const [list, setList] = useState({ mistakes: null, more: false, offline: false });
  const [state, setState] = useState(null); // GET /api/learn/reports
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState('');
  const load = useCallback(async (before = null) => {
    try {
      const data = await api('GET', `/api/learn/mistakes?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      const items = (data && data.mistakes) || [];
      setList(now => ({ mistakes: before ? [...(now.mistakes || []), ...items] : items, more: Boolean(data && data.more), offline: Boolean(data && data.offline) }));
    } catch (failure) {
      setList(now => ({ ...now, mistakes: now.mistakes || [] }));
      ui.notify(errorText(failure), 'error');
    }
  }, [ui]);
  const loadState = useCallback(() => api('GET', '/api/learn/reports').then(data => { setState(data || {}); if (data && data.running) setRunning(true); }, () => setState({ reports: [], model: { ready: false }, failed: true })), []);
  useEffect(() => { void load(); void loadState(); }, [load, loadState]);

  const analyze = async () => {
    setRunning(true);
    setFailed('');
    try {
      const lang = typeof I18n !== 'undefined' && I18n.get() === 'zh' ? 'zh' : 'en';
      const data = await api('POST', '/api/learn/reports', { lang });
      void loadState();
      if (data && data.report) open({ kind: 'report', uid: data.report.uid, report: data.report, parent: { kind: 'mistakes' } });
    } catch (failure) {
      setFailed(errorText(failure) || t('Operation failed'));
    } finally {
      setRunning(false);
    }
  };
  const practise = async () => {
    try {
      const data = await api('GET', '/api/learn/queue?mode=mistakes&limit=50');
      const cards = (data && data.cards) || [];
      if (cards.length) open({ kind: 'session', mode: 'mistakes', preset: cards }); else ui.notify(t('No mistakes to review'), 'info');
    } catch (failure) { ui.notify(errorText(failure), 'error'); }
  };

  const reports = (state && state.reports) || [];
  const since = state && state.since;
  const newCount = since ? Number(since.mistakes) || 0 : 0;
  const ready = Boolean(state && state.model && state.model.ready);
  const mistakes = list.mistakes;
  return (
    <ViewFrame {...frame}>
      <Card id="h5-learn-analyze-card" sx={{ p: 2 }}>
        <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 500, lineHeight: 1.4 }}>{t('Why do I get these wrong?')}</Typography>
        <Typography variant="body2" color="text.secondary" id="h5-learn-analyze-note" sx={{ mt: 0.5 }}>
          {!state ? t('Loading…') : null}
          {state && state.offline ? t('Mistake reports are kept on a normal computer, which cannot be reached right now') : null}
          {state && !state.offline && since ? (
            <>
              {since.from
                ? <Fmt template={newCount === 1 ? '1 mistake since the last report ({2}).' : '{1} mistakes since the last report ({2}).'} values={[newCount, shortDate(since.from)]} />
                : <Fmt template={newCount === 1 ? '1 mistake so far.' : '{1} mistakes so far.'} values={[newCount]} />}
              {' '}{ready ? t('The analysis uses your translation model.') : null}
            </>
          ) : null}
        </Typography>
        {state && !state.offline && !ready ? (
          <Alert severity="info" id="h5-learn-analyze-no-model" sx={{ mt: 1.5 }}
            action={<Button color="inherit" size="small" id="h5-learn-analyze-settings" onClick={openTranslator}>{t('Open Settings')}</Button>}>
            {t('The analysis needs an AI translation model (DeepSeek or GLM) in Settings → Voice and translation. The list and the tags work without it.')}
          </Alert>
        ) : null}
        {failed ? <Alert severity="error" id="h5-learn-analyze-error" role="alert" sx={{ mt: 1.5 }}>{failed}</Alert> : null}
        {running ? (
          <Box sx={{ mt: 1.5 }} id="h5-learn-analyzing">
            <Typography variant="body2" color="text.secondary">{t('Analyzing your mistakes… this can take a minute.')}</Typography>
            <LinearProgress sx={{ mt: 1, height: 4, borderRadius: 2 }} aria-label={t('Analyzing your mistakes… this can take a minute.')} />
          </Box>
        ) : null}
        <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button variant="contained" id="h5-learn-analyze" disabled={!ready || running || !newCount} onClick={analyze}>{t('Analyze')}</Button>
          {reports.length ? <Button id="h5-learn-last-report" onClick={() => open({ kind: 'report', uid: reports[0].uid, parent: { kind: 'mistakes' } })}>{t('Last report')}</Button> : null}
          {reports.length > 1 ? <Button id="h5-learn-all-reports" onClick={() => open({ kind: 'reports', parent: { kind: 'mistakes' } })}>{t('All reports')}</Button> : null}
        </Box>
      </Card>
      {list.offline ? <Alert severity="info" id="h5-learn-mistakes-offline">{t('Only the mistakes made on this computer are shown until your other computer can be reached.')}</Alert> : null}
      {!mistakes ? <Typography variant="body2" color="text.secondary">{t('Loading…')}</Typography> : null}
      {mistakes && !mistakes.length ? (
        <Card id="h5-learn-mistakes-empty" sx={{ p: 2 }}>
          <Typography variant="h6" component="p">{t('No mistakes to review')}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{t('Words and sentences you get wrong show up here.')}</Typography>
        </Card>
      ) : null}
      {mistakes && mistakes.length ? (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: -1 }}>
            <Typography variant="overline" component="h3" color="text.secondary" sx={{ flex: '1 1 auto', lineHeight: 2 }}>{t('Mistakes, newest first')}</Typography>
            <Button size="small" id="h5-learn-practise-mistakes" onClick={practise}>{t('Practise them')}</Button>
          </Box>
          <Card component="ul" id="h5-learn-mistakes" sx={{ listStyle: 'none', m: 0, px: 2, py: 0 }}>
            {mistakes.map(item => <MistakeRow key={item.uid} item={item} />)}
          </Card>
          {list.more ? <Box><Button id="h5-learn-mistakes-more" onClick={() => load(mistakes[mistakes.length - 1].at)}>{t('Show more')}</Button></Box> : null}
        </>
      ) : null}
    </ViewFrame>
  );
}

function MistakeRow({ item }) {
  return (
    <Box component="li" className="h5-learn-mistake" data-tag={item.tag || undefined} sx={{ py: 1.5, borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
        <Typography variant="body1" translate="no" className="h5-learn-mistake-expected" sx={{ flex: '1 1 auto', minWidth: 0, color: 'success.light', overflowWrap: 'break-word' }}>{item.expected}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>{when(item.at)}</Typography>
      </Box>
      <Typography variant="body2" className="h5-learn-mistake-written" sx={{ color: 'error.light', overflowWrap: 'break-word' }}>
        {item.written ? <Fmt template="You wrote: {1}" values={[item.written]} /> : t("You didn't know it")}
      </Typography>
      <Box sx={{ display: 'flex', gap: 0.75, mt: 0.75, flexWrap: 'wrap' }}>
        <Chip size="small" variant="outlined" className="h5-learn-mode-chip" label={t(MODE_LABELS[item.mode] || 'Review')} />
        {item.tag ? <Chip size="small" variant="outlined" color="warning" className="h5-learn-tag-chip" label={t(TAG_LABELS[item.tag] || 'other')} /> : null}
        {item.hinted ? <Chip size="small" variant="outlined" className="h5-learn-hint-chip" label={t('with help')} /> : null}
      </Box>
    </Box>
  );
}

// ── All reports ──

export function ReportsView({ frame, open, ui }) {
  const [reports, setReports] = useState(null);
  useEffect(() => {
    let live = true;
    api('GET', '/api/learn/reports').then(data => { if (live) setReports((data && data.reports) || []); }, failure => { if (live) { setReports([]); ui.notify(errorText(failure), 'error'); } });
    return () => { live = false; };
  }, [ui]);
  return (
    <ViewFrame {...frame}>
      {!reports ? <Typography variant="body2" color="text.secondary">{t('Loading…')}</Typography> : null}
      {reports && !reports.length ? <Typography variant="body2" color="text.secondary">{t('No reports yet')}</Typography> : null}
      {(reports || []).map(report => (
        <Card key={report.uid} className="h5-learn-report-row">
          <CardActionArea onClick={() => open({ kind: 'report', uid: report.uid, parent: { kind: 'reports', parent: { kind: 'mistakes' } } })} sx={{ p: 2 }}>
            <Typography variant="caption" component="p" color="text.secondary">
              {range(report)}{' · '}<Fmt template={report.mistakes === 1 ? '1 mistake' : '{1} mistakes'} values={[report.mistakes]} />{' · '}{t(report.auto ? 'Weekly' : 'Asked for')}
            </Typography>
            <Typography variant="body2" translate="no" sx={{ mt: 0.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{report.summary}</Typography>
          </CardActionArea>
        </Card>
      ))}
    </ViewFrame>
  );
}

// ── One report ──

export function ReportView({ frame, view, ui, open, data }) {
  const [report, setReport] = useState(view.report || null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (view.report) return undefined;
    let live = true;
    api('GET', `/api/learn/reports/${encodeURIComponent(view.uid)}`).then(answer => { if (live) setReport(answer && answer.report); }, failure => { if (live) setError(errorText(failure)); });
    return () => { live = false; };
  }, [view.uid, view.report]);
  // An automatic report opened here is not offered on the Learn home again, on any device (the setting is shared).
  useEffect(() => {
    const settings = data && data.settings;
    if (!report || !report.auto || !settings || settings.report_seen === report.uid) return;
    api('PUT', '/api/learn/settings', { report_seen: report.uid }).then(next => { if (next) data.setSettings(next); void data.reload(); }, () => {});
  }, [report]); // eslint-disable-line react-hooks/exhaustive-deps -- once per report
  const refs = report ? uniqueCards(report.findings || []) : [];
  const practise = async () => {
    try {
      const answer = await api('POST', '/api/learn/cards/find', { refs });
      const cards = (answer && answer.cards) || [];
      if (cards.length) open({ kind: 'session', mode: 'mistakes', preset: cards }); else ui.notify(t('These cards are not on this computer yet.'), 'info');
    } catch (failure) { ui.notify(errorText(failure), 'error'); }
  };
  if (error) return <ViewFrame {...frame}><Alert severity="error" id="h5-learn-report-error">{error}</Alert></ViewFrame>;
  if (!report) return <ViewFrame {...frame}><Typography variant="body2" color="text.secondary">{t('Loading…')}</Typography></ViewFrame>;
  const kinds = report.kinds || [];
  const top = Math.max(1, ...kinds.map(kind => kind.count));
  return (
    <ViewFrame {...frame}>
      <Card id="h5-learn-report" sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary" id="h5-learn-report-range">
          {range(report)}{' · '}<Fmt template="{1} mistakes in {2} answers" values={[report.mistakes, report.answers]} />
        </Typography>
        <Typography variant="subtitle1" component="p" translate="no" id="h5-learn-report-summary" sx={{ mt: 1, lineHeight: 1.5, overflowWrap: 'break-word' }}>{report.summary}</Typography>
        {kinds.length ? (
          <Box component="ul" id="h5-learn-report-kinds" sx={{ listStyle: 'none', m: 0, p: 0, mt: 1.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
            {kinds.map(kind => (
              <Box component="li" key={kind.kind} className="h5-learn-report-kind" sx={{ display: 'grid', gridTemplateColumns: 'minmax(96px, 38%) 1fr 32px', alignItems: 'center', columnGap: 1.5 }}>
                <Typography variant="body2">{t(KIND_LABELS[kind.kind] || 'Other')}</Typography>
                <LinearProgress variant="determinate" value={Math.round((kind.count / top) * 100)} aria-label={t(KIND_LABELS[kind.kind] || 'Other')} sx={{ height: 8, borderRadius: 4 }} />
                <Typography variant="body2" color="text.secondary" align="right">{kind.count}</Typography>
              </Box>
            ))}
          </Box>
        ) : null}
      </Card>
      {(report.findings || []).length ? (
        <Card id="h5-learn-report-findings" sx={{ px: 2, py: 1 }}>
          {report.findings.map((finding, index) => (
            <Box key={index} className="h5-learn-finding">
              {index ? <Divider sx={{ mx: -2 }} /> : null}
              <Box sx={{ py: 1.5 }}>
                <Typography variant="subtitle1" component="h3" translate="no" sx={{ fontWeight: 500, lineHeight: 1.4 }}>{finding.title}</Typography>
                {finding.cause ? <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}><Box component="span" sx={{ color: 'text.primary', fontWeight: 500 }}>{t('Cause')}</Box>{' · '}<span translate="no">{finding.cause}</span></Typography> : null}
                {finding.action ? <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}><Box component="span" sx={{ color: 'text.primary', fontWeight: 500 }}>{t('What to do')}</Box>{' · '}<span translate="no">{finding.action}</span></Typography> : null}
                {(finding.cards || []).length ? (
                  <Typography variant="caption" component="p" color="text.secondary" translate="no" sx={{ mt: 0.5 }}>
                    {finding.cards.slice(0, 3).map(card => card.en).join(' · ')}{finding.cards.length > 3 ? ` +${finding.cards.length - 3}` : ''}
                  </Typography>
                ) : null}
              </Box>
            </Box>
          ))}
          {refs.length ? (
            <>
              <Divider sx={{ mx: -2 }} />
              <Box sx={{ py: 1.5 }}>
                <Button variant="contained" id="h5-learn-report-practise" onClick={practise}>{tf(refs.length === 1 ? 'Practise this card' : 'Practise these {1} cards', refs.length)}</Button>
              </Box>
            </>
          ) : null}
        </Card>
      ) : null}
      {report.model ? <Typography variant="caption" color="text.secondary" component="p" translate="no">{report.model}</Typography> : null}
    </ViewFrame>
  );
}
const uniqueCards = findings => {
  const seen = new Set();
  return findings.flatMap(finding => finding.cards || []).filter(card => { const key = `${card.kind}|${String(card.en).toLowerCase()}`; if (seen.has(key)) return false; seen.add(key); return true; });
};

// The one line on the Learn home when a new weekly report is ready (summary.new_report).
export function NewReportLine({ report, onView }) {
  return (
    <Alert severity="info" id="h5-learn-new-report" action={<Button color="inherit" size="small" id="h5-learn-new-report-view" onClick={onView}>{t('View')}</Button>}>
      <Fmt template={report.mistakes === 1 ? 'Your weekly mistake report is ready (1 mistake).' : 'Your weekly mistake report is ready ({1} mistakes).'} values={[report.mistakes]} />
    </Alert>
  );
}
