export default function GuestBookingNextStepsPage() {
  return (
    <main className="pageShell" data-testid="guest-booking-next-steps">
      <section lang="fr" dir="ltr" aria-labelledby="booking-next-fr">
        <h1 id="booking-next-fr">Continuer votre réservation</h1>
        <p>Quand vos informations sont prêtes, suivez ces étapes simples.</p>
        <ol>
          <li>Retournez au parcours de réservation invité.</li>
          <li>Choisissez la clinique et le médecin souhaités.</li>
          <li>Indiquez au moins un moyen de contact : téléphone ou e-mail.</li>
          <li>
            Vérifiez vos informations, puis envoyez la demande une seule fois.
          </li>
        </ol>
        <p>
          Ce guide ne demande aucun paiement, mot de passe, document médical ou
          code d’accès invité.
        </p>
      </section>

      <section lang="ar" dir="rtl" aria-labelledby="booking-next-ar">
        <h1 id="booking-next-ar">تابع حجز موعدك</h1>
        <p>عندما تصبح معلوماتك جاهزة، اتبع هذه الخطوات البسيطة.</p>
        <ol>
          <li>ارجع إلى مسار حجز الموعد للزائر.</li>
          <li>اختر العيادة والطبيب المطلوبين.</li>
          <li>
            أدخل وسيلة تواصل واحدة على الأقل: الهاتف أو البريد الإلكتروني.
          </li>
          <li>راجع معلوماتك ثم أرسل الطلب مرة واحدة فقط.</li>
        </ol>
        <p>
          هذا الدليل لا يطلب أي دفع أو كلمة مرور أو مستند طبي أو رمز دخول
          للزائر.
        </p>
      </section>
    </main>
  );
}
