// ─── Where Join would be, on a pod whose main pod keeps the viewer out (Stefan, 22 Nov 2026) ──────────────────────
// The main pod's director chose that its pods are for its members, and the viewer is not one: the page says so and
// links the main pod (when the viewer may see it), instead of a Join the server would refuse.
import { Link } from 'react-router-dom';
import { joinGateLine } from './nested-pods-view';

export default function PodMainPodGate({ mainPod }: { mainPod: { id: string; name: string } | null }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3" data-testid="pod-main-gate">
      <p className="min-w-0 break-words text-sm text-gray-600">{joinGateLine(mainPod?.name ?? null)}</p>
      {mainPod && (
        <Link
          to={`/pods/${mainPod.id}`}
          className="inline-flex min-h-[44px] items-center rounded-xl border border-gray-300 bg-white px-4 text-sm font-semibold text-[#1a1a2e] hover:bg-gray-50"
          data-testid="pod-main-gate-link"
        >
          Go to {mainPod.name}
        </Link>
      )}
    </div>
  );
}
