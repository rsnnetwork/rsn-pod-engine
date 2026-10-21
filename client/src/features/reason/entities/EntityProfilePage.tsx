// client/src/features/reason/entities/EntityProfilePage.tsx
// /entities/:entityId, the v4 prototype's Entity Profile: full screen with its own header, like the Human Profile.
// "This organisation is context. The humans are the opportunity": the entity, then the people around it.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EntityPage } from '@rsn/shared';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { E } from '@/realtime/entities';
import { Skeleton } from '@/components/ui/Spinner';
import { cn } from '@/lib/utils';
import ReasonMark from '../brand/ReasonMark';
import ReasonSheep from '../brand/ReasonSheep';
import { shouldRetry, statusOf, viewFor } from '../human/profile-text';
import ConfirmSheet from './ConfirmSheet';
import EditEntitySheet from './EditEntitySheet';
import EntityHero from './EntityHero';
import EntityPeople from './EntityPeople';
import RelationshipPanel from './RelationshipPanel';
import { archiveEntity, entityKeys, fetchEntity } from './entity-api';
import { entityError, isEntityId, loadFailedLine } from './entity-text';
import { PRIMARY_BUTTON, QUIET_BUTTON } from './look';

// Side margins that also keep clear of the notch when a phone is on its side (the Human Profile's own).
const SIDES = 'pl-[max(12px,env(safe-area-inset-left))] pr-[max(12px,env(safe-area-inset-right))] md:pl-[max(22px,env(safe-area-inset-left))] md:pr-[max(22px,env(safe-area-inset-right))]';
const MAIN = 'mx-auto w-full max-w-[1264px] md:max-w-[1284px]';

function Loading() {
  return (
    <main className={cn(MAIN, SIDES, 'grid gap-3 py-4')} aria-busy="true">
      <span className="sr-only" role="status">Loading this entity</span>
      <Skeleton className="h-[30vh] rounded-[21px] border border-reason-line bg-white" />
      <Skeleton className="h-40 rounded-[21px] border border-reason-line bg-white" />
    </main>
  );
}

function Notice({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
      <ReasonSheep pose="thinking" className="h-24 w-24" />
      <h1 className="text-[20px] font-bold">{title}</h1>
      <p className="text-[14px] text-[#646a77]">{text}</p>
      <div className="mt-2 flex flex-wrap justify-center gap-2.5">{children}</div>
    </main>
  );
}

interface ProfileProps {
  page: EntityPage;
  me: string | undefined;
  /** An archive (or a leave that may archive) is on its way: the page stops asking for itself until it is answered. */
  onClosing: (closing: boolean) => void;
}

// The entity itself, once its page is in. Keyed by the entity, so the sheets start fresh when one page opens another.
function EntityProfile({ page, me, onClosing }: ProfileProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const sending = useRef(false);
  const { entity } = page;

  // A page opened from another starts at its top. The app scrolls smoothly (index.css); this one jump must not.
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, []);

  const archive = useMutation({
    networkMode: 'always',
    mutationFn: () => archiveEntity(entity.id),
    onMutate: () => onClosing(true),
    onSuccess: () => {
      addToast(`${entity.name} is archived.`, 'success');
      // Its page is closed now, so the page you are on is the list (replaced: Back does not return to a closed page).
      navigate('/entities', { replace: true });
      return qc.invalidateQueries({ queryKey: entityKeys.all });
    },
    onError: (err) => {
      onClosing(false);
      setArchiveError(entityError(err, 'Could not archive it just now. Try again in a moment.'));
      return statusOf(err) === 404 ? qc.invalidateQueries({ queryKey: entityKeys.page(entity.id) }) : undefined;
    },
    onSettled: () => { sending.current = false; },
  });
  const pressArchive = () => {
    if (sending.current) return;
    sending.current = true;
    setArchiveError(null);
    archive.mutate();
  };

  return (
    <main className={cn(MAIN, SIDES, 'pb-[calc(40px+env(safe-area-inset-bottom))] pt-3 md:pt-6')}>
      <EntityHero
        page={page}
        relationship={<RelationshipPanel page={page} me={me} onClosing={onClosing} />}
        onEdit={() => setEditing(true)}
        onArchive={() => { setArchiveError(null); setArchiving(true); }}
      />
      <EntityPeople page={page} me={me} />
      {editing && page.canEdit && <EditEntitySheet entity={entity} onClose={() => setEditing(false)} />}
      <ConfirmSheet
        open={archiving}
        title={`Archive ${entity.name}?`}
        text="It leaves every list and profile, and its page closes. The people linked to it stay linked, and its name is free again for someone else to use."
        confirmLabel="Archive"
        busyLabel="Archiving…"
        busy={archive.isPending}
        error={archiveError}
        onConfirm={pressArchive}
        onClose={() => setArchiving(false)}
      />
    </main>
  );
}

export default function EntityProfilePage() {
  const { entityId: param = '' } = useParams();
  // The server reads an id in any case as the same entity; so does the page (one cache entry).
  const entityId = param.toLowerCase();
  const validId = isEntityId(entityId);
  const location = useLocation();
  const navigate = useNavigate();
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  // While an archive (or a leave that may archive) is on its way, the page does not ask for itself. Its 404, from its own
  // refresh or from the realtime tag (which can arrive before the answer), would otherwise draw "not available" for a
  // moment on the way to the list: the route change is a transition, and this page stays on screen until it commits.
  const [closing, setClosing] = useState(false);

  // The contract's tags for this page: entity:<id> (an edit, an archive, someone joining, leaving or changing role) and
  // the member's own user:<me>:entities (their own link changing, on this tab or another).
  const { data: page, error, fetchStatus, isError, isPending, refetch } = useQuery({
    queryKey: entityKeys.page(entityId),
    queryFn: () => fetchEntity(entityId),
    // An address that is no entity id (a typo, a crafted link) is answered without asking the server.
    enabled: validId && !!me && !closing,
    // A 4xx is an answer, so asking again changes nothing; a lost connection or a 5xx gets one more try.
    retry: shouldRetry,
    meta: { entities: me && validId ? [E.entity(entityId), E.userEntities(me)] : [] },
  });

  // The first screen of the app in this tab (a shared link): going back would leave the app, so go to the list.
  const back = () => {
    if (location.key === 'default') navigate('/entities', { replace: true });
    else navigate(-1);
  };
  // The Human Profile's rule for one query's state: a page already on screen stays through a failed refetch, and
  // only "gone" (404, or an id that is no entity's) replaces it.
  const view = viewFor({ hasBrief: !!page, validId, isPending, isError, error, fetchStatus });

  return (
    <div className="min-h-[100dvh] bg-[#f6f5f3] font-reason text-reason-ink antialiased">
      <header className="sticky top-0 z-[5] flex h-[calc(60px+env(safe-area-inset-top))] items-center justify-between gap-3 border-b border-reason-line bg-white/95 pl-[max(11px,env(safe-area-inset-left))] pr-[max(11px,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] backdrop-blur-lg md:h-[calc(70px+env(safe-area-inset-top))] md:pl-[max(24px,env(safe-area-inset-left))] md:pr-[max(24px,env(safe-area-inset-right))]">
        <div className="flex items-center gap-2.5">
          <button type="button" onClick={back} className="min-h-[44px] rounded-full border border-reason-line bg-white px-3.5 text-[13px] font-extrabold">← Back</button>
          <span className="hidden sm:inline"><ReasonMark variant="mobile" /></span>
        </div>
        <span className="rounded-full bg-[#f2f3f5] px-2.5 py-1.5 text-[10px] font-extrabold tracking-[0.08em] text-[#555d69]">ENTITY</span>
      </header>

      {view === 'profile' && page ? (
        <EntityProfile key={entityId} page={page} me={me} onClosing={setClosing} />
      ) : view === 'loading' ? (
        <Loading />
      ) : view === 'unavailable' ? (
        <Notice title="This entity is not available." text="It may have been archived, or the link is not quite right.">
          <button type="button" onClick={() => navigate('/entities', { replace: true })} className={PRIMARY_BUTTON}>See all entities</button>
          <button type="button" onClick={back} className={QUIET_BUTTON}>Go back</button>
        </Notice>
      ) : (
        <Notice title="We could not load this entity just now." text={loadFailedLine(error, fetchStatus)}>
          <button type="button" onClick={() => void refetch()} className={PRIMARY_BUTTON}>Try again</button>
          <button type="button" onClick={back} className={QUIET_BUTTON}>Go back</button>
        </Notice>
      )}
    </div>
  );
}
