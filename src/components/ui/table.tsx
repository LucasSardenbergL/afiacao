import * as React from "react";

import { cn } from "@/lib/utils";

const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => {
    const scrollRef = React.useRef<HTMLDivElement>(null);
    const phantomRef = React.useRef<HTMLDivElement>(null);
    const innerRef = React.useRef<HTMLDivElement>(null);
    const syncing = React.useRef<"none" | "scroll" | "phantom">("none");
    const [width, setWidth] = React.useState(0);
    const [overflowing, setOverflowing] = React.useState(false);

    React.useEffect(() => {
      const el = scrollRef.current;
      if (!el) return;
      const update = () => {
        setWidth(el.scrollWidth);
        setOverflowing(el.scrollWidth > el.clientWidth + 1);
      };
      update();
      const ro = new ResizeObserver(update);
      ro.observe(el);
      if (el.firstElementChild) ro.observe(el.firstElementChild as Element);
      return () => ro.disconnect();
    }, []);

    const onScrollMain = () => {
      if (syncing.current === "phantom") { syncing.current = "none"; return; }
      if (!scrollRef.current || !phantomRef.current) return;
      syncing.current = "scroll";
      phantomRef.current.scrollLeft = scrollRef.current.scrollLeft;
    };
    const onScrollPhantom = () => {
      if (syncing.current === "scroll") { syncing.current = "none"; return; }
      if (!scrollRef.current || !phantomRef.current) return;
      syncing.current = "phantom";
      scrollRef.current.scrollLeft = phantomRef.current.scrollLeft;
    };

    return (
      <div className="relative w-full">
        <div ref={scrollRef} onScroll={onScrollMain} className="relative w-full overflow-auto">
          <div ref={innerRef}>
            <table ref={ref} className={cn("w-full caption-bottom text-sm", className)} {...props} />
          </div>
        </div>
        {overflowing && (
          <div
            ref={phantomRef}
            onScroll={onScrollPhantom}
            className="sticky bottom-2 z-20 overflow-x-auto overflow-y-hidden h-3 bg-background/90 backdrop-blur-sm rounded-full shadow-md border border-border/50 mt-1"
            aria-hidden="true"
          >
            <div style={{ width, height: 1 }} />
          </div>
        )}
      </div>
    );
  },
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <thead ref={ref} className={cn("[&_tr]:border-b", className)} {...props} />,
);
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
  ),
);
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tfoot ref={ref} className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)} {...props} />
  ),
);
TableFooter.displayName = "TableFooter";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn("border-b transition-colors data-[state=selected]:bg-muted hover:bg-muted/50", className)}
      {...props}
    />
  ),
);
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        "h-12 px-4 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  ),
);
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td ref={ref} className={cn("p-4 align-middle [&:has([role=checkbox])]:pr-0", className)} {...props} />
  ),
);
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<HTMLTableCaptionElement, React.HTMLAttributes<HTMLTableCaptionElement>>(
  ({ className, ...props }, ref) => (
    <caption ref={ref} className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />
  ),
);
TableCaption.displayName = "TableCaption";

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
