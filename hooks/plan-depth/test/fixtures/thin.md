# Plan: weekly sales report tool (thin)

Build a small tool that reads sales data and produces summaries.

## Context

Reports are built by hand in a spreadsheet each Monday. We want one command instead.

## Features

### Data import

**Goal:** load sales rows from CSV files.

- Loads a 10,000-row file in under 2 seconds.
- Rejects a file with a missing column.

### Summary report

**Goal:** totals per region and per month.

- Totals match the spreadsheet to the cent.

### CSV export

**Goal:** export the summary as CSV.

- Column order is stable between runs.

## Timeline

Week 1: import. Week 2: summary. Week 3: export.

## Risks

Data quality may vary.
