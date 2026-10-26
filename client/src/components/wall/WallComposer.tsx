// The box a member writes a post in. On the circle wall it is always a box; on the pod wall it is one line
// ("Write something to the pod…") until it is tapped, so the discussion does not push the pod's events and
// members a whole screen down on a phone. Once tapped it stays open: closing it again when the box lost the
// focus took its own buttons away under the finger, because a tap on "Add an image" or Post takes the focus from
// the box before it lands, and the tap then fell on whatever had moved up into their place.
//
// What was typed is kept until the server has taken it: a refusal (the write limit, a pod that has just been
// archived, a lost connection) says why and leaves the text where it was. The client id stays with the text
// across retries, so a double tap or a dropped connection cannot post it twice.

import { useState } from 'react';
import { Send, ImagePlus, Loader2, X } from 'lucide-react';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import api from '@/lib/api';
import { isCloudinaryConfigured, uploadImageToCloudinary } from '@/lib/cloudinary';
import { useToastStore } from '@/stores/toastStore';
import { isConflict, wallErrorSentence } from './wall-logic';
import type { WallConfig } from './wall-types';

export default function WallComposer({ config, onSettled }: {
  config: WallConfig;
  /** The post was saved, or the server answered that the wall changed under the writer: the feed is read again. */
  onSettled: () => void;
}) {
  const addToast = useToastStore((s) => s.addToast);
  const [draft, setDraft] = useState('');
  const [clientId, setClientId] = useState(() => crypto.randomUUID());
  const [image, setImage] = useState<{ url: string; uploading: boolean } | null>(null);
  const [posting, setPosting] = useState(false);
  const [opened, setOpened] = useState(false);

  const open = config.composer === 'open' || opened || draft.length > 0 || image !== null;

  const attachImage = async (file: File) => {
    setImage({ url: '', uploading: true });
    try {
      const res = await uploadImageToCloudinary(file);
      setImage({ url: res.url, uploading: false });
    } catch (err) {
      setImage(null);
      addToast(err instanceof Error && err.message ? err.message : 'Image upload failed.', 'error');
    }
  };

  const submit = async () => {
    const content = draft.trim();
    if (posting || (!content && !image?.url)) return;
    setPosting(true);
    try {
      await api.post(config.feedPath, {
        clientId,
        content,
        media: image?.url ? [{ type: 'image', url: image.url }] : [],
      });
      setDraft('');
      setImage(null);
      setClientId(crypto.randomUUID());
      // Never held on the refetch: a slow one would keep the box disabled for seconds.
      onSettled();
    } catch (err) {
      addToast(wallErrorSentence(err, 'Could not post.'), 'error');
      // The pod was archived since the page last looked: read the feed again, so the box that was just
      // refused goes, and says why. What was typed stays until it does.
      if (isConflict(err)) onSettled();
    } finally {
      setPosting(false);
    }
  };

  return (
    <Card className="!p-4">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setOpened(true)}
        placeholder={config.copy.placeholder}
        aria-label={config.copy.placeholder}
        maxLength={8000}
        rows={open ? (config.composer === 'open' ? 2 : 3) : 1}
        className="min-h-[44px] w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-rsn-red/30 resize-none"
      />
      {image && (
        <div className="relative mt-2 inline-block">
          {image.uploading
            ? <div className="flex h-20 w-28 items-center justify-center rounded-lg bg-gray-100"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
            : <img src={image.url} alt="" className="h-20 rounded-lg object-cover" />}
          <button
            type="button"
            onClick={() => setImage(null)}
            className="absolute -right-3.5 -top-3.5 flex h-11 w-11 items-center justify-center"
            aria-label="Remove image"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-800 text-white"><X className="h-3.5 w-3.5" /></span>
          </button>
        </div>
      )}
      {open && (
        <div className="mt-2 flex items-center justify-between">
          {isCloudinaryConfigured() ? (
            <label className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center text-gray-400 hover:text-gray-700" title="Add an image">
              <ImagePlus className="h-5 w-5" />
              <input
                type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void attachImage(f); e.target.value = ''; }}
              />
            </label>
          ) : <span />}
          <Button size="sm" onClick={() => void submit()} disabled={posting || image?.uploading || (!draft.trim() && !image?.url)} className="min-h-[44px]">
            <Send className="mr-1.5 h-4 w-4" /> {posting ? 'Posting…' : 'Post'}
          </Button>
        </div>
      )}
    </Card>
  );
}
