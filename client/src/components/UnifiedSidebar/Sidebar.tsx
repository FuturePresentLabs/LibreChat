import { memo } from 'react';
import { MessagesSquare, TerminalSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { NavLink } from '~/common';
import SidePanelNav from '~/components/SidePanel/Nav';
import { DEFAULT_PANEL, useActivePanel } from '~/Providers';
import { useLocalize } from '~/hooks';
import ExpandedPanel from './ExpandedPanel';
import { cn } from '~/utils';

function ModeSwitcher({ links, routeActiveId }: { links: NavLink[]; routeActiveId?: string }) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { setActive } = useActivePanel();
  const hasAgents = links.some((link) => link.id === 'edgerunner');
  const agentsLink = links.find((link) => link.id === 'edgerunner');
  const isAgents = routeActiveId === 'edgerunner';

  if (!hasAgents) {
    return null;
  }

  const switchToChat = () => {
    setActive(DEFAULT_PANEL);
    if (isAgents) {
      navigate('/c/new');
    }
  };

  const switchToAgents = () => {
    agentsLink?.onClick?.();
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

function Sidebar({
  links,
  expanded,
  width,
  minWidth,
  maxWidth,
  onCollapse,
  onExpand,
  onLeaveInsights,
  routeActiveId,
  onResizeStart,
  onResizeKeyboard,
}: {
  links: NavLink[];
  expanded: boolean;
  width: number;
  minWidth: number;
  maxWidth: number;
  onCollapse: () => void;
  onExpand: () => void;
  onLeaveInsights: () => void;
  routeActiveId?: string;
  onResizeStart: (e: React.MouseEvent) => void;
  onResizeKeyboard: (direction: 'shrink' | 'grow') => void;
}) {
  return (
    <>
      <div className="flex h-full w-full overflow-hidden">
        <ExpandedPanel
          links={links}
          expanded={expanded}
          onCollapse={onCollapse}
          onExpand={onExpand}
          onLeaveInsights={onLeaveInsights}
          routeActiveId={routeActiveId}
        />
        <nav
          className={cn(
            'min-h-0 flex-1 overflow-hidden bg-surface-primary-alt',
            expanded ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
          style={{ transition: expanded ? 'opacity 200ms ease 80ms' : 'opacity 150ms ease' }}
          aria-hidden={!expanded}
        >
          <div className="flex h-full min-h-0 flex-col">
            <ModeSwitcher links={links} routeActiveId={routeActiveId} />
            <div className="min-h-0 flex-1">
              <SidePanelNav links={links} />
            </div>
          </div>
        </nav>
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={Math.round(width)}
        aria-valuemin={Math.round(minWidth)}
        aria-valuemax={Math.round(maxWidth)}
        tabIndex={expanded ? 0 : -1}
        className={cn(
          'absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-border-medium active:bg-border-heavy',
          expanded ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        style={{ transition: expanded ? 'opacity 200ms ease 80ms' : 'opacity 150ms ease' }}
        onMouseDown={onResizeStart}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') {
            onResizeKeyboard('shrink');
          } else if (e.key === 'ArrowRight') {
            onResizeKeyboard('grow');
          }
        }}
      />
    </>
  );
}

export default memo(Sidebar);
