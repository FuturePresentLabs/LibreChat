import { memo } from 'react';
import { MessagesSquare, TerminalSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { NavLink } from '~/common';
import { DEFAULT_PANEL, useActivePanel } from '~/Providers';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

function ModeSwitcher({
  links,
  routeActiveId,
  onNavigate,
}: {
  links: NavLink[];
  routeActiveId?: string;
  onNavigate?: () => void;
}) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { setActive } = useActivePanel();
  const agentsLink = links.find((link) => link.id === 'edgerunner');
  const isAgents = routeActiveId === 'edgerunner';

  if (!agentsLink) {
    return null;
  }

  const switchToChat = () => {
    setActive(DEFAULT_PANEL);
    if (isAgents) {
      navigate('/c/new');
    }
    onNavigate?.();
  };

  const switchToAgents = () => {
    agentsLink.onClick?.();
    onNavigate?.();
  };

  return (
    <div className="border-b border-border-light p-2">
      <div
        className="grid h-9 grid-cols-2 rounded-lg bg-surface-secondary p-1"
        aria-label={localize('com_edgerunner_mode_switcher')}
      >
        <button
          type="button"
          aria-pressed={!isAgents}
          className={cn(
            'flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
            !isAgents
              ? 'bg-surface-primary text-text-primary shadow-sm'
              : 'text-text-secondary hover:text-text-primary',
          )}
          onClick={switchToChat}
        >
          <MessagesSquare className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{localize('com_ui_chat')}</span>
        </button>
        <button
          type="button"
          aria-pressed={isAgents}
          className={cn(
            'flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
            isAgents
              ? 'bg-surface-primary text-text-primary shadow-sm'
              : 'text-text-secondary hover:text-text-primary',
          )}
          onClick={switchToAgents}
        >
          <TerminalSquare className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{localize('com_edgerunner_title')}</span>
        </button>
      </div>
    </div>
  );
}

export default memo(ModeSwitcher);
