// ─── The made-up people the tour's pictures show (25 Oct 2026) ───────────────
//
// Stefan and Claus, 25 Oct (ONB-05): the tour may show people again, as long as it is clear they are made
// up, with English names and varied roles, an employee among them. One list, so the preview's tour and the
// live one show the same people. No company names, and each picture carries an "Example" label.
//
// The names were checked against the members' names before shipping.

export interface ExamplePerson {
  name: string;
  role: string;
}

export const EXAMPLE_PEOPLE: ReadonlyArray<ExamplePerson> = [
  { name: 'Emma Clarke', role: 'Product manager' },
  { name: 'James Hughes', role: 'Founder' },
  { name: 'Olivia Bennett', role: 'Investor' },
  { name: 'Daniel Walsh', role: 'Head of sales' },
  { name: 'Hannah Moore', role: 'Freelance designer' },
  { name: 'Thomas Reid', role: 'Engineering lead' },
];
