import { useGetHistory } from "@workspace/api-client-react";
import { format } from "date-fns";
import { Loader2, Code2, TerminalSquare, AlertCircle, Play } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import { useCreateSession } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

export default function HistoryPage() {
  const { data: history, isLoading, error } = useGetHistory();
  const [, setLocation] = useLocation();
  const createSession = useCreateSession();
  const { toast } = useToast();

  const handleOpenInRepl = (code: string) => {
    // Instead of directly passing code via URL params (too long), 
    // we save it as an unsaved temporary session or just copy it into a session.
    // For simplicity, we just save a draft session.
    createSession.mutate({ data: { name: `Draft ${format(new Date(), "HH:mm:ss")}`, code, description: "Loaded from history" } }, {
      onSuccess: (data) => {
        setLocation(`/session/${data.id}`);
      },
      onError: (err: any) => {
        toast({ title: "Failed to load to REPL", description: err.message, variant: "destructive" });
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
        Failed to load history.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="p-6 border-b border-border bg-card flex justify-between items-end">
        <div>
          <h1 className="text-2xl font-mono font-bold tracking-tight">Execution History</h1>
          <p className="text-muted-foreground text-sm font-mono mt-1">Review your recent REPL executions</p>
        </div>
      </div>

      <ScrollArea className="flex-1 p-6">
        <div className="space-y-8 max-w-5xl mx-auto">
          {history?.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground font-mono">
              No history found. Run some code in the REPL first!
            </div>
          ) : (
            history?.map((entry) => (
              <div key={entry.id} className="border border-border rounded-lg overflow-hidden bg-card">
                <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/20">
                  <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
                    <span>{format(new Date(entry.executedAt), "PP pp")}</span>
                    <span>•</span>
                    <span>{entry.executionTimeMs}ms</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className={`text-xs font-mono px-2 py-0.5 rounded ${entry.exitCode === 0 ? 'bg-primary/10 text-primary' : 'bg-destructive/10 text-destructive'}`}>
                      Exit Code: {entry.exitCode}
                    </div>
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-xs font-mono" onClick={() => handleOpenInRepl(entry.code)} disabled={createSession.isPending}>
                      <Play className="w-3 h-3 mr-1" /> Load
                    </Button>
                  </div>
                </div>
                
                <div className="p-4 space-y-4">
                  <div>
                    <div className="flex items-center gap-2 mb-2 text-xs font-mono text-muted-foreground uppercase tracking-wider">
                      <Code2 className="w-3.5 h-3.5" /> Code
                    </div>
                    <pre className="p-3 bg-[#0a0a0a] rounded text-sm font-mono overflow-x-auto text-foreground/90 border border-border/50">
                      <code>{entry.code}</code>
                    </pre>
                  </div>

                  {(entry.stdout || entry.stderr) && (
                    <>
                      <Separator className="bg-border/50" />
                      <div>
                        <div className="flex items-center gap-2 mb-2 text-xs font-mono text-muted-foreground uppercase tracking-wider">
                          {entry.stderr ? <AlertCircle className="w-3.5 h-3.5 text-destructive" /> : <TerminalSquare className="w-3.5 h-3.5" />} 
                          Output
                        </div>
                        <pre className="p-3 bg-[#050505] rounded text-xs font-mono overflow-x-auto border border-border/50">
                          {entry.stderr && <code className="text-destructive block mb-1">{entry.stderr}</code>}
                          {entry.stdout && <code className="text-foreground block">{entry.stdout}</code>}
                        </pre>
                      </div>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
