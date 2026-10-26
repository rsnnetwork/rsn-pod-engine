// Stand-in for client/src/lib/api.ts in the render-loop harness: answers the few GETs the C7 forms make, from fixed
// rows, after a short wait as a network would. Nothing is ever posted: the harness only watches the forms sit idle.
interface Answer { data: { data: unknown } }

const role = (id: string) => (id === 'P3' ? 'host' : 'director');
const PODS = [
  { id: 'P1', name: 'Test', podType: 'reason', orchestrationMode: 'free_form', status: 'active' },
  { id: 'P2', name: 'Founders', podType: 'speed_networking', orchestrationMode: 'timed_rounds', status: 'active' },
  { id: 'P3', name: 'Chatters', podType: 'chat', orchestrationMode: 'free_form', status: 'active' },
];

async function get(url: string): Promise<Answer> {
  await new Promise((resolve) => setTimeout(resolve, 40));
  if (url.startsWith('/pods/')) {
    const pod = PODS.find((p) => p.id === url.split('/')[2]);
    if (!pod) throw Object.assign(new Error('Not found'), { response: { status: 404, data: { error: { code: 'POD_NOT_FOUND' } } } });
    return { data: { data: { ...pod, memberRole: role(pod.id) } } };
  }
  if (url.startsWith('/pods?')) return { data: { data: PODS.map((p) => ({ ...p, memberRole: role(p.id) })) } };
  if (url === '/admin/templates') return { data: { data: [{ id: 't1', name: 'Balanced', isDefault: true }] } };
  throw Object.assign(new Error(`No stand-in for GET ${url}`), { response: { status: 404, data: {} } });
}

const refuse = (method: string) => async (url: string): Promise<Answer> => {
  throw new Error(`The render-loop harness sends nothing (${method} ${url})`);
};

const api = { get, post: refuse('POST'), put: refuse('PUT'), patch: refuse('PATCH'), delete: refuse('DELETE') };

export default api;
