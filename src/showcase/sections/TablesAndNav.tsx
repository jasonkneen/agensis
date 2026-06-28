import { useState } from 'react';
import { SectionShell, Example } from '@/showcase/SectionShell';
import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from '@/components/ui/table';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
} from '@/components/ui/breadcrumb';

type Invoice = {
  invoice: string;
  status: 'Paid' | 'Pending' | 'Unpaid';
  method: string;
  amount: string;
};

const invoices: Invoice[] = [
  { invoice: 'INV-001', status: 'Paid', method: 'Credit Card', amount: '$250.00' },
  { invoice: 'INV-002', status: 'Pending', method: 'PayPal', amount: '$150.00' },
  { invoice: 'INV-003', status: 'Unpaid', method: 'Bank Transfer', amount: '$350.00' },
  { invoice: 'INV-004', status: 'Paid', method: 'Credit Card', amount: '$450.00' },
];

const TOTAL_PAGES = 5;

export default function TablesAndNavSection() {
  const [page, setPage] = useState(2);

  const goTo = (next: number) => setPage(Math.min(TOTAL_PAGES, Math.max(1, next)));

  return (
    <SectionShell title="Tables & Navigation" description="Tables, pagination and breadcrumbs">
      <Example label="Table" full>
        <Table>
          <TableCaption>A list of recent invoices.</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Invoice</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Method</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoices.map((row) => (
              <TableRow key={row.invoice}>
                <TableCell className="font-medium">{row.invoice}</TableCell>
                <TableCell>{row.status}</TableCell>
                <TableCell>{row.method}</TableCell>
                <TableCell className="text-right">{row.amount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={3}>Total</TableCell>
              <TableCell className="text-right">$1,200.00</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </Example>

      <Example label="Pagination" full>
        <div className="flex w-full flex-col items-center gap-2">
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    goTo(page - 1);
                  }}
                />
              </PaginationItem>
              {[1, 2, 3].map((n) => (
                <PaginationItem key={n}>
                  <PaginationLink
                    href="#"
                    isActive={page === n}
                    onClick={(e) => {
                      e.preventDefault();
                      goTo(n);
                    }}
                  >
                    {n}
                  </PaginationLink>
                </PaginationItem>
              ))}
              <PaginationItem>
                <PaginationEllipsis />
              </PaginationItem>
              <PaginationItem>
                <PaginationLink
                  href="#"
                  isActive={page === TOTAL_PAGES}
                  onClick={(e) => {
                    e.preventDefault();
                    goTo(TOTAL_PAGES);
                  }}
                >
                  {TOTAL_PAGES}
                </PaginationLink>
              </PaginationItem>
              <PaginationItem>
                <PaginationNext
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    goTo(page + 1);
                  }}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
          <span className="text-xs text-muted-foreground">
            Page {page} of {TOTAL_PAGES}
          </span>
        </div>
      </Example>

      <Example label="Breadcrumb" full>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="#">Home</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbEllipsis />
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="#">Components</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Breadcrumb</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </Example>
    </SectionShell>
  );
}
