import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import GeminiPlayer from './yuban-original.jsx';

function hideAiControls(root) {
  root.querySelectorAll('[data-ai-control]').forEach((control) => control.remove());
  root.querySelectorAll('button').forEach((button) => {
    const title = String(button.getAttribute('title') || '');
    const isAiPhone = Boolean(button.querySelector('svg.lucide-phone, svg[class*="phone"]'));
    if (isAiPhone || /gemini|ai|live/i.test(title)) button.remove();
  });
}

function OfflinePlayer() {
  useEffect(() => {
    const root = document.body;
    const observer = new MutationObserver(() => hideAiControls(root));
    hideAiControls(root);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return <GeminiPlayer />;
}

createRoot(document.getElementById('root')).render(<OfflinePlayer />);
