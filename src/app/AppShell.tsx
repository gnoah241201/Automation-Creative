import React from 'react';

export type AppTab = 'resize' | 'composer' | 'library';

interface AppShellProps {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  children: React.ReactNode;
}

const visibleTabs: Array<{ id: Extract<AppTab, 'resize' | 'composer'>; label: string }> = [
  { id: 'resize', label: 'Resize' },
  { id: 'composer', label: 'Hook Composer' },
];

export function AppShell({ activeTab, onTabChange, children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <nav
        aria-label="Main tools"
        className="sticky top-0 z-[90] border-b border-neutral-800 bg-neutral-950/95 px-3 py-3 backdrop-blur sm:px-5"
      >
        <div className="mx-auto flex max-w-[1800px] items-center gap-2 overflow-x-auto">
          <span className="mr-2 shrink-0 font-bold sm:mr-4">ResizeVideo</span>
          <div aria-label="Video tools" className="flex gap-2">
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                aria-current={activeTab === tab.id ? 'page' : undefined}
                onClick={() => onTabChange(tab.id)}
                className={activeTab === tab.id
                  ? 'shrink-0 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white'
                  : 'shrink-0 rounded-lg px-3 py-2 text-sm text-neutral-400 hover:bg-neutral-900 hover:text-white'}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </nav>
      <main id="app-workspace">
        {children}
      </main>
    </div>
  );
}
