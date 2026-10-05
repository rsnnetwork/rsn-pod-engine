import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import Sheet from '../ui/Sheet';

export default function LogoutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const confirm = async () => {
    onClose();
    await logout();
    navigate('/login');
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Log out?"
      footer={(
        <>
          <button type="button" onClick={onClose} className="min-h-[44px] rounded-[11px] border border-reason-line px-4 text-[14px] font-bold">Cancel</button>
          <button type="button" onClick={confirm} className="min-h-[44px] rounded-[11px] bg-reason-red px-4 text-[14px] font-bold text-white">Log out</button>
        </>
      )}
    >
      <p className="py-2 text-[14px] text-reason-muted">You can sign back in any time.</p>
    </Sheet>
  );
}
