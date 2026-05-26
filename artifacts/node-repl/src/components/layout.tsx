import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Terminal, History, BookMarked, Code2 } from "lucide-react";

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();

  const links = [
    { href: "/", label: "REPL", icon: Terminal },
    { href: "/history", label: "History", icon: History },
    { href: "/sessions", label: "Sessions", icon: BookMarked },
  ];

  return (
    <div className="flex h-screen w-full bg-background text-foreground dark">
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-sidebar flex flex-col">
        <div className="p-4 border-b border-border flex items-center gap-2">
          <Code2 className="w-5 h-5 text-primary" />
          <span className="font-mono font-bold tracking-tight text-primary">NODE_REPL</span>
        </div>
        
        <nav className="flex-1 p-3 space-y-1">
          {links.map((link) => {
            const isActive = location === link.href;
            return (
              <Link key={link.href} href={link.href} className={`flex items-center gap-3 px-3 py-2 text-sm font-mono rounded-md transition-colors ${isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
                <link.icon className="w-4 h-4" />
                {link.label}
              </Link>
            );
          })}
        </nav>
        
        <div className="p-4 border-t border-border text-xs text-muted-foreground font-mono">
          v0.1.0-alpha
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {children}
      </main>
    </div>
  );
}
