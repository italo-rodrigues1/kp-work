import * as React from "react";
import { cn } from "../../lib/utils";

function Avatar({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("relative flex size-8 shrink-0 overflow-hidden rounded-full", className)} {...props} />;
}

function AvatarFallback({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex size-full items-center justify-center rounded-full bg-muted text-xs font-medium", className)} {...props} />;
}

export { Avatar, AvatarFallback };
