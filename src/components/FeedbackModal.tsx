import { useRef, useState } from 'react';
import { useLang } from '../lib/i18n';
import { useModalFocus } from '../lib/useModalFocus';

/**
 * Feedback: one message, sent deliberately.
 *
 * Posts { m } (the message text) to /api/feedback, a route with its own KV
 * namespace. There is no reply channel and no contact field; someone who
 * wants an answer writes their contact into the message.
 */
const MAX = 2000; // mirrors FEEDBACK_MAX_TEXT in worker/index.js

type State = 'editing' | 'sending' | 'sent' | 'error';

export function FeedbackModal({ onClose }: { onClose: () => void }) {
  const lang = useLang();
  const zh = lang === 'zh';
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, true);
  const [text, setText] = useState('');
  const [state, setState] = useState<State>('editing');

  const title = zh ? '发送反馈' : 'Send feedback';
  const send = async () => {
    const m = text.trim();
    if (!m || state === 'sending') return;
    setState('sending');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ m: m.slice(0, MAX) }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setState('sent');
      window.setTimeout(onClose, 1400);
    } catch {
      // Say so rather than pretending it landed — a suggestion box that
      // silently drops messages is worse than none.
      setState('error');
    }
  };

  return (
    <div
      className="picker-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="docs fb"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(e) => {
          // IME composition (Chinese/Japanese input): Escape cancels the
          // candidate word, it must not also close the dialog — this is the
          // one surface where that costs the user the whole message, since
          // nothing drafts it. Guards ⌘/Ctrl+Enter mid-composition too.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Escape') onClose();
          // ⌘/Ctrl+Enter submits — the convention for a textarea in a dialog,
          // where plain Enter has to stay a newline.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send();
        }}
      >
        <div className="docs-head">
          <span className="docs-title">{title}</span>
          <button
            className="pk-close"
            onClick={onClose}
            aria-label={zh ? '关闭' : 'Close'}
            title={zh ? '关闭' : 'Close'}
          >
            ×
          </button>
        </div>
        <div className="fb-body">
          {state === 'sent' ? (
            <p className="fb-thanks">
              {zh ? '收到了，谢谢 🐾' : 'Got it — thank you 🐾'}
            </p>
          ) : (
            <>
              <p className="fb-hint">
                {zh
                  ? '哪里好用、哪里别扭、想要什么市场或功能——都可以说。需要回复的话，请在正文里留下你的联系方式。'
                  : 'What works, what annoys you, a market or feature you want — anything. Want a reply? Leave your contact in the message.'}
              </p>
              <textarea
                className="fb-text"
                value={text}
                autoFocus
                maxLength={MAX}
                onChange={(e) => setText(e.target.value)}
                placeholder={zh ? '写点什么…' : 'Tell us anything…'}
                aria-label={title}
              />
              <div className="fb-foot">
                <span className={`fb-count${text.length > MAX - 100 ? ' near' : ''}`}>
                  {text.length}/{MAX}
                </span>
                {state === 'error' && (
                  <span className="fb-err">
                    {zh ? '没发出去，稍后再试' : "Didn't send — try again in a moment"}
                  </span>
                )}
                <button
                  className="accent-btn fb-send"
                  onClick={send}
                  disabled={text.trim().length === 0 || state === 'sending'}
                >
                  {state === 'sending' ? (zh ? '发送中…' : 'Sending…') : zh ? '发送' : 'Send'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
