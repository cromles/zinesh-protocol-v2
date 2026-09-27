import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { acceptCell, approveRelease, createCell, currentRole, DEVELOPMENT_PAYEE_ID, getCell, getCells,
  prototypeFunding, rejectCell, requestRelease, subscribeToRole, switchRole, userMessage } from './api';
import type { CellState, CellSummary, Role } from './api';
import { formatTryAmount } from './money';

export function App() {
  const [role, setRole] = useState<Role | null>(currentRole());
  const [authError, setAuthError] = useState('');
  useEffect(() => subscribeToRole((nextRole) => {
    setRole(nextRole);
    if (nextRole === null) setAuthError('Oturum sona erdi. Devam etmek için rolünüzü yeniden seçin.');
  }), []);
  const chooseRole = async (next: Role) => {
    try { await switchRole(next); setAuthError(''); }
    catch (error) { setAuthError(userMessage(error)); }
  };
  if (!role) return <main className="shell narrow"><p className="eyebrow">ZINESH · DEVELOPMENT</p><h1>Nasıl devam ediyorsun?</h1>
    <p>İki taraflı anlaşma akışını denemek için bir rol seç.</p><div className="role-switch">
      <button onClick={() => void chooseRole('payer')}>PAYER olarak devam et</button>
      <button className="secondary" onClick={() => void chooseRole('payee')}>PAYEE olarak devam et</button>
    </div>{authError && <ErrorMessage message={authError} />}</main>;
  return <div className="app-shell"><header className="topbar"><Link to="/agreements" className="brand">zinesh</Link>
    <div className="role-switch compact"><span>Development:</span><button className={role === 'payer' ? 'selected' : ''} onClick={() => void chooseRole('payer')}>Payer</button>
      <button className={role === 'payee' ? 'selected' : ''} onClick={() => void chooseRole('payee')}>Payee</button></div></header>
    <Routes><Route path="/agreements" element={<AgreementList />} /><Route path="/agreements/new" element={<NewAgreement />} />
      <Route path="/agreements/:cellId" element={<AgreementRoom role={role} />} /><Route path="*" element={<Navigate to="/agreements" replace />} /></Routes>
  </div>;
}

function AgreementList() {
  const [cells, setCells] = useState<CellSummary[]>([]); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { try { setCells(await getCells()); setError(''); } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const role = currentRole();
  return <main className="shell"><div className="page-heading"><div><p className="eyebrow">ANLAŞMALAR</p><h1>Anlaşmalar</h1></div>{role === 'payer' && <Link className="button" to="/agreements/new">Yeni anlaşma</Link>}</div>
    {error && <ErrorMessage message={error} />}{loading ? <p className="muted">Yükleniyor…</p> : cells.length === 0
      ? <section className="empty"><h2>Henüz anlaşma yok</h2><p>İlk anlaşmanı oluşturup diğer tarafı davet et.</p>{role === 'payer' && <Link className="button" to="/agreements/new">Anlaşma oluştur</Link>}</section>
      : <ul className="agreement-list">{cells.map((cell) => <li key={cell.cellId}><Link to={`/agreements/${encodeURIComponent(cell.cellId)}`}>
        <span className="agreement-main"><strong>{cell.description || 'Anlaşma'}</strong><small>Karşı taraf · {cell.counterpartyId}</small></span>
        <span className="agreement-side"><strong>{formatTryAmount(cell.amount)}</strong><small>{statusLabel(cell.status, cell.acceptanceStatus)}</small></span>
      </Link></li>)}</ul>}
  </main>;
}

function NewAgreement() {
  const role = currentRole();
  const navigate = useNavigate(); const [amount, setAmount] = useState('');
  const [description, setDescription] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await createCell({ payee: DEVELOPMENT_PAYEE_ID, amountTry: amount, description });
      if (result.outcome !== 'SUCCESS') throw new Error(result.error?.code ?? 'CREATE_FAILED');
      navigate(`/agreements/${encodeURIComponent(result.cellId)}`);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  if (!canCreateAgreement(role)) return <main className="shell narrow"><Link className="back-link" to="/agreements">← Anlaşmalar</Link><p className="eyebrow">YENİ ANLAŞMA</p>
    <h1>Yeni anlaşmayı PAYER oluşturur</h1><p>Development rolünü Payer olarak değiştirip yeniden dene.</p></main>;
  return <main className="shell narrow"><Link className="back-link" to="/agreements">← Anlaşmalar</Link><p className="eyebrow">YENİ ANLAŞMA</p><h1>Ne üzerinde anlaşıyorsunuz?</h1>
    <form className="form" onSubmit={(e) => void submit(e)}><p className="demo-note">Development/demo sınırı: Bu akış yalnızca sabit development-payee kimliğini kullanır.</p>
      <label>Payee ID (sabit)<input value={DEVELOPMENT_PAYEE_ID} readOnly /></label>
      <label>Tutar (TRY)<input inputMode="decimal" placeholder="100,00" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
      <label>Açıklama<textarea value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={256} rows={4} /></label>
      {error && <ErrorMessage message={error} />}<button disabled={busy}>{busy ? 'Gönderiliyor…' : 'Anlaşmayı gönder'}</button></form>
  </main>;
}

export function canCreateAgreement(role: Role | null): boolean {
  return role === 'payer';
}

function AgreementRoom({ role }: { role: Role }) {
  const { cellId = '' } = useParams(); const [view, setView] = useState<AgreementRoomView>({ scope: null, cell: null, loading: true, error: '' });
  const [busy, setBusy] = useState(false); const requestId = useRef(0);
  const scope = `${role}:${cellId}`;
  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setView(agreementRoomViewOnLoad(scope));
    try {
      const nextCell = await loadAgreementRoomCell(cellId, role);
      if (currentRequest === requestId.current) setView(agreementRoomViewOnSuccess(scope, nextCell));
    } catch (e) {
      if (currentRequest === requestId.current) setView(agreementRoomViewOnFailure(scope, e));
    }
  }, [cellId, role, scope]);
  useEffect(() => {
    void load();
    return () => { requestId.current += 1; };
  }, [load]);
  const act = async (action: () => Promise<unknown>) => { setBusy(true); try { await action(); await load(); } catch (e) { setView((current) => ({ ...current, error: errorMessage(e) })); } finally { setBusy(false); } };
  if (agreementRoomIsLoading(view, scope)) return <main className="shell"><p className="muted">Anlaşma yükleniyor…</p></main>;
  if (!view.cell) return <main className="shell narrow"><Link className="back-link" to="/agreements">← Anlaşmalar</Link><ErrorMessage message={view.error} /></main>;
  const cell = view.cell;
  const counterparty = role === 'payer' ? cell.payee : cell.payer;
  const actions = visibleAgreementActions(cell, role);
  const stateMessage = agreementStateMessage(cell);
  return <main className="shell narrow"><Link className="back-link" to="/agreements">← Anlaşmalar</Link><p className="eyebrow">ANLAŞMA ODASI</p>
    <h1>{cell.description || 'Anlaşma'}</h1><dl className="details"><div><dt>Karşı taraf</dt><dd>{counterparty}</dd></div><div><dt>Tutar</dt><dd>{formatTryAmount(cell.amount)}</dd></div>
      <div><dt>Durum</dt><dd>{statusLabel(cell.status, cell.acceptanceStatus)}</dd></div></dl>
    {view.error && <ErrorMessage message={view.error} />}{actions.accept && <section className="next-step"><h2>Karşı tarafın yanıtı bekleniyor</h2>
      <div className="actions"><button disabled={busy} onClick={() => void act(() => acceptCell(cell.cellId))}>Kabul et</button>
        <button className="secondary" disabled={busy} onClick={() => void act(() => rejectCell(cell.cellId))}>Reddet</button></div></section>}
    {actions.demoFunding && <section className="next-step"><h2>Anlaşma kabul edildi</h2>
      <p className="demo-note">Demo funding — gerçek para kullanılmaz.</p><button disabled={busy} onClick={() => void act(() => prototypeFunding(cell.cellId))}>Demo funding</button></section>}
    {cell.status === 'FUNDED' && <section className="next-step"><h2>Anlaşma devam ediyor</h2><p>İş tamamlandığında taraflardan biri teslimi onay isteği olarak iletebilir.</p>
      <div className="actions">{actions.requestRelease && <button disabled={busy} onClick={() => void act(() => requestRelease(cell.cellId))}>Tamamlanma iste</button>}
      {actions.approveRelease && <button className="secondary" disabled={busy} onClick={() => void act(() => approveRelease(cell.cellId))}>Tamamlanmayı onayla</button>}</div></section>}
    {stateMessage && <section className="next-step"><h2>{stateMessage}</h2></section>}
  </main>;
}

function ErrorMessage({ message }: { message: string }) {
  return <p role="alert" className="error">{message}</p>;
}

function errorMessage(error: unknown): string {
  return userMessage(error);
}
export function visibleAgreementActions(cell: CellState, role: Role): {
  accept: boolean; demoFunding: boolean; requestRelease: boolean; approveRelease: boolean;
} {
  const actor = role === 'payer' ? 'development-payer' : 'development-payee';
  const isParticipant = actor === cell.payer || actor === cell.payee;
  return {
    accept: cell.status === 'CREATED' && cell.acceptanceStatus === 'PENDING' && role === 'payee' && actor === cell.payee,
    demoFunding: cell.status === 'CREATED' && cell.acceptanceStatus === 'ACCEPTED' && role === 'payer' && actor === cell.payer,
    requestRelease: cell.status === 'FUNDED' && isParticipant && cell.releaseRequestedBy === undefined,
    approveRelease: cell.status === 'FUNDED' && isParticipant && cell.releaseRequestedBy !== undefined
      && cell.releaseRequestedBy !== actor,
  };
}

export interface AgreementRoomView {
  scope: string | null;
  cell: CellState | null;
  loading: boolean;
  error: string;
}

export function agreementRoomIsLoading(view: AgreementRoomView, currentScope: string): boolean {
  return view.loading || view.scope !== currentScope;
}

export function agreementRoomViewOnLoad(scope: string): AgreementRoomView {
  return { scope, cell: null, loading: true, error: '' };
}

export function agreementRoomViewOnSuccess(scope: string, cell: CellState): AgreementRoomView {
  return { scope, cell, loading: false, error: '' };
}

export function agreementRoomViewOnFailure(scope: string, error: unknown): AgreementRoomView {
  return { scope, cell: null, loading: false, error: errorMessage(error) };
}

export function loadAgreementRoomCell(
  cellId: string,
  role: Role,
  fetchCell: (id: string) => Promise<CellState> = getCell,
): Promise<CellState> {
  // The active role is held by the API client; this argument scopes the component's reload lifecycle.
  void role;
  return fetchCell(cellId);
}

export function statusLabel(status: string, acceptance: string): string {
  const statusLabels: Record<string, string> = {
    RELEASED: 'Tamamlandı', REFUNDED: 'İade edildi', EXPIRED: 'Süresi doldu', DISPUTED: 'İncelemede',
  };
  if (statusLabels[status] !== undefined) return statusLabels[status]!;
  if (acceptance === 'REJECTED') return 'Reddedildi';
  if (acceptance === 'PENDING') return 'Yanıt bekleniyor';
  return ({ CREATED: 'Kabul edildi', FUNDED: 'Devam ediyor' } as Record<string, string>)[status] ?? status;
}

export function agreementStateMessage(cell: CellState): string | null {
  if (cell.status === 'RELEASED') return 'Anlaşma tamamlandı.';
  if (cell.status === 'REFUNDED') return 'İade edildi. Tutar Payer’a iade edildi.';
  if (cell.status === 'EXPIRED') return 'Anlaşmanın funding süresi doldu.';
  if (cell.status === 'DISPUTED') return 'Anlaşma incelemede.';
  if (cell.acceptanceStatus === 'REJECTED') return 'Anlaşma Payee tarafından reddedildi.';
  if (cell.refundRequestedBy !== undefined) {
    return cell.refundRequestedBy === cell.payer
      ? 'İade talebi bekliyor. Payee onayı bekleniyor.'
      : 'İade talebi bekliyor.';
  }
  return null;
}
