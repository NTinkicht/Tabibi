import Link from "next/link";

export default function GuestBookingContactHelpPage() {
  return (
    <main>
      <section lang="fr" dir="ltr" aria-labelledby="booking-contact-fr">
        <h1 id="booking-contact-fr">Coordonnées pour votre réservation</h1>
        <p>
          Ajoutez au moins un moyen de contact pour que la clinique puisse vous
          joindre au sujet de votre réservation.
        </p>
        <ul>
          <li>Choisissez téléphone si vous préférez être appelé.</li>
          <li>Choisissez e-mail si vous préférez recevoir un message.</li>
          <li>Le moyen choisi doit être renseigné avant la confirmation.</li>
        </ul>
        <Link href="/guest/booking-help">Revenir à la préparation</Link>
      </section>

      <section lang="ar" dir="rtl" aria-labelledby="booking-contact-ar">
        <h1 id="booking-contact-ar">بيانات التواصل للحجز</h1>
        <p>
          أضف وسيلة تواصل واحدة على الأقل حتى تتمكن العيادة من التواصل معك
          بخصوص الحجز.
        </p>
        <ul>
          <li>اختر الهاتف إذا كنت تفضل الاتصال الهاتفي.</li>
          <li>اختر البريد الإلكتروني إذا كنت تفضل استلام رسالة.</li>
          <li>يجب إدخال وسيلة التواصل التي اخترتها قبل تأكيد الحجز.</li>
        </ul>
        <Link href="/guest/booking-help">العودة إلى التحضير</Link>
      </section>
    </main>
  );
}
