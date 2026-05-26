import { useListSessions, useDeleteSession, getListSessionsQueryKey } from "@workspace/api-client-react";
import { format } from "date-fns";
import { Loader2, Trash2, Code2, Clock, Play } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";

export default function SessionsPage() {
  const { data: sessions, isLoading, error } = useListSessions();
  const deleteSession = useDeleteSession();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const handleDelete = (id: number) => {
    if (!confirm("Are you sure you want to delete this session?")) return;
    
    deleteSession.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Session deleted" });
        queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
      }
    });
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-destructive">
        Failed to load sessions.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="p-6 border-b border-border bg-card">
        <h1 className="text-2xl font-mono font-bold tracking-tight">Saved Sessions</h1>
        <p className="text-muted-foreground text-sm font-mono mt-1">Manage your saved code snippets</p>
      </div>

      <ScrollArea className="flex-1 p-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6 max-w-7xl mx-auto">
          {sessions?.length === 0 ? (
            <div className="col-span-full text-center py-12 text-muted-foreground font-mono">
              No saved sessions. Save one from the REPL!
            </div>
          ) : (
            sessions?.map((session) => (
              <div key={session.id} className="flex flex-col border border-border rounded-lg overflow-hidden bg-card hover:border-primary/50 transition-colors group/card">
                <div className="p-4 border-b border-border flex justify-between items-start gap-4 bg-muted/10">
                  <div className="min-w-0">
                    <h3 className="font-mono font-bold truncate" title={session.name}>{session.name}</h3>
                    {session.description && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2 font-sans">
                        {session.description}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover/card:opacity-100 transition-opacity">
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-8 w-8 text-primary hover:text-primary/80 shrink-0"
                      onClick={() => setLocation(`/session/${session.id}`)}
                    >
                      <Play className="w-4 h-4" />
                    </Button>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => handleDelete(session.id)}
                      disabled={deleteSession.isPending}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
                
                <div 
                  className="flex-1 p-4 bg-[#0a0a0a] relative cursor-pointer group"
                  onClick={() => setLocation(`/session/${session.id}`)}
                >
                  <pre className="text-xs font-mono text-foreground/80 line-clamp-6 overflow-hidden">
                    <code>{session.code}</code>
                  </pre>
                  <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0a] to-transparent pointer-events-none" />
                  <div className="absolute inset-0 bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                    <Button variant="secondary" size="sm" className="font-mono text-xs opacity-0 group-hover:opacity-100 transform translate-y-2 group-hover:translate-y-0 transition-all">
                      Open in REPL
                    </Button>
                  </div>
                </div>
                
                <div className="px-4 py-3 border-t border-border bg-muted/20 flex items-center justify-between text-xs text-muted-foreground font-mono">
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-3 h-3" />
                    {format(new Date(session.createdAt), "MMM d, yyyy")}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Code2 className="w-3 h-3" />
                    {session.code.split('\n').length} lines
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
