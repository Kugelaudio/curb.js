/**
 * The calendar's rules as plain functions, so they run without the framework. A booking number
 * comes from a counter that only goes up: counting the list instead hands out a number twice
 * after a cancellation, and one cancel would then remove both bookings.
 */

export type Appointment = { id: string; service: string; date: string; time: string; name: string };
export type Book = { appointments: Appointment[]; nextNumber: number };

export function addAppointment(book: Book, appointment: Omit<Appointment, "id">) {
  const created = { ...appointment, id: `B-${book.nextNumber}` };
  return {
    book: { appointments: [...book.appointments, created], nextNumber: book.nextNumber + 1 },
    created,
  };
}

export function removeAppointment(book: Book, id: string) {
  return {
    book: { ...book, appointments: book.appointments.filter((a) => a.id !== id) },
    removed: book.appointments.some((a) => a.id === id),
  };
}
