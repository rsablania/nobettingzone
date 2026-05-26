import { useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { Play, Save, Loader2, Code2 } from "lucide-react";
import { useExecuteCode, useCreateSession, useGetSession, getGetSessionQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export default function ReplPage({ params }: { params?: { id?: string } }) {
  const sessionId = params?.id ? parseInt(params.id, 10) : undefined;
  
  const { data: session, isLoading: isLoadingSession } = useGetSession(sessionId!, { 
    query: { 
      enabled: !!sessionId, 
      queryKey: getGetSessionQueryKey(sessionId!) 
    } 
  });

  const [code, setCode] = useState('// Write your Node.js code here\nconsole.log("Hello, REPL!");\n');
  const [result, setResult] = useState<{ stdout: string, stderr: string, exitCode: number, executionTimeMs: number, error: string | null } | null>(null);
  const [isSessionDialogOpen, setIsSessionDialogOpen] = useState(false);
  const [sessionName, setSessionName] = useState("");
  const [sessionDesc, setSessionDesc] = useState("");
  const codeInitializedForId = useRef<number | null>(null);
  
  const executeCode = useExecuteCode();
  const createSession = useCreateSession();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (session && codeInitializedForId.current !== session.id) {
      setCode(session.code);
      setSessionName(session.name);
      setSessionDesc(session.description || "");
      codeInitializedForId.current = session.id;
    }
  }, [session]);

  const handleRun = () => {
    if (!code.trim()) return;
    executeCode.mutate({ data: { code } }, {
      onSuccess: (data) => {
        setResult(data);
      },
      onError: (err: any) => {
        toast({
          title: "Execution failed",
          description: err.message || "An error occurred",
          variant: "destructive"
        });
      }
    });
  };

  const handleSaveSession = () => {
    if (!sessionName.trim()) {
      toast({ title: "Name required", variant: "destructive" });
      return;
    }
    createSession.mutate({ data: { name: sessionName, code, description: sessionDesc } }, {
      onSuccess: (data) => {
        toast({ title: "Session saved successfully!" });
        setIsSessionDialogOpen(false);
        setLocation(`/session/${data.id}`);
      },
      onError: (err: any) => {
        toast({
          title: "Failed to save session",
          description: err.message || "An error occurred",
          variant: "destructive"
        });
      }
    });
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        handleRun();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [code, executeCode.isPending]);

  if (sessionId && isLoadingSession) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Editor Header */}
      <div className="flex-none h-12 border-b border-border bg-card flex items-center justify-between px-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground font-mono">
          <Code2 className="w-4 h-4 text-primary" />
          {session ? session.name : "index.js"}
          {session && <span className="px-1.5 py-0.5 bg-primary/10 text-primary text-[10px] rounded uppercase">Saved</span>}
        </div>
        <div className="flex items-center gap-2">
          <Dialog open={isSessionDialogOpen} onOpenChange={setIsSessionDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 font-mono text-xs">
                <Save className="w-3.5 h-3.5 mr-1" />
                {session ? "Save as new" : "Save"}
              </Button>
            </DialogTrigger>
            <DialogContent className="dark text-foreground bg-card border-border sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="font-mono">{session ? "Save Session As" : "Save Session"}</DialogTitle>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <Label htmlFor="name" className="font-mono text-xs">Name</Label>
                  <Input 
                    id="name" 
                    value={sessionName}
                    onChange={(e) => setSessionName(e.target.value)}
                    className="font-mono bg-background" 
                    placeholder="e.g. Data parser" 
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="desc" className="font-mono text-xs">Description (Optional)</Label>
                  <Textarea 
                    id="desc" 
                    value={sessionDesc}
                    onChange={(e) => setSessionDesc(e.target.value)}
                    className="font-mono bg-background resize-none" 
                  />
                </div>
              </div>
              <DialogFooter>
                <Button onClick={handleSaveSession} disabled={createSession.isPending} className="font-mono text-xs">
                  {createSession.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  Save Session
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Button 
            size="sm" 
            className="h-8 font-mono text-xs bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={handleRun}
            disabled={executeCode.isPending}
          >
            {executeCode.isPending ? (
              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5 mr-1" />
            )}
            Run <kbd className="ml-2 px-1.5 py-0.5 bg-black/20 rounded font-sans text-[10px] opacity-70">⌘↵</kbd>
          </Button>
        </div>
      </div>

      {/* Editor Pane */}
      <div className="flex-1 overflow-auto bg-[#0d0d0d]">
        <CodeMirror
          value={code}
          height="100%"
          extensions={[javascript()]}
          theme="dark"
          onChange={(value) => setCode(value)}
          className="text-sm font-mono h-full"
        />
      </div>

      {/* Output Pane */}
      <div className="flex-none h-64 border-t border-border bg-[#050505] flex flex-col">
        <div className="h-8 border-b border-border/50 flex items-center px-4 bg-muted/20">
          <span className="font-mono text-xs text-muted-foreground uppercase tracking-wider">Output</span>
          {result && (
            <div className="ml-auto flex items-center gap-3 font-mono text-[10px]">
              <span className={result.exitCode === 0 ? "text-primary" : "text-destructive"}>
                Exit: {result.exitCode}
              </span>
              <span className="text-muted-foreground">
                Time: {result.executionTimeMs}ms
              </span>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-auto p-4 font-mono text-xs">
          {!result && !executeCode.isPending && (
            <div className="text-muted-foreground/50 h-full flex items-center justify-center italic">
              Run code to see output
            </div>
          )}
          {executeCode.isPending && (
            <div className="text-primary h-full flex items-center justify-center animate-pulse">
              Executing...
            </div>
          )}
          {result && (
            <div className="space-y-4">
              {result.error && (
                <div className="text-destructive whitespace-pre-wrap">{result.error}</div>
              )}
              {result.stderr && (
                <div className="text-destructive whitespace-pre-wrap">{result.stderr}</div>
              )}
              {result.stdout && (
                <div className="text-foreground whitespace-pre-wrap">{result.stdout}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
