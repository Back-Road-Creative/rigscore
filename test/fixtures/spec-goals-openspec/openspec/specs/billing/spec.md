# billing Specification

## Purpose

How the product bills a customer.

## Requirements

### Requirement: Invoice Delivery
The system SHALL email an invoice within one minute of a charge.

#### Scenario: Charge succeeds
- GIVEN a charged customer
- WHEN the charge settles
- THEN an invoice is emailed
