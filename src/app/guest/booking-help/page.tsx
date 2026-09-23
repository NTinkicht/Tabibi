export default function GuestBookingHelpPage() {
  return (
    <main className="pageShell" data-testid="guest-booking-help">
      <section lang="fr" dir="ltr" aria-labelledby="booking-help-fr">
        <h1 id="booking-help-fr">Préparer votre réservation</h1>
        <p>
          Avant de commencer, préparez les informations nécessaires pour éviter
          une interruption pendant la réservation.
        </p>
        <h2>À préparer</h2>
        <ul>
          <li>La clinique et le médecin que vous souhaitez consulter.</li>
          <li>Au moins un moyen de contact : téléphone ou e-mail.</li>
          <li>
            Si vous choisissez un contact préféré, renseignez bien ce téléphone
            ou cet e-mail.
          </li>
        </ul>
        <p>
          Cette page d’aide ne demande aucun paiement, mot de passe ou document
          médical.
        </p>
      </section>

      <section lang="ar" dir="rtl" aria-labelledby="booking-help-ar">
        <h1 id="booking-help-ar">استعد لحجز موعدك</h1>
        <p>قبل البدء، جهّز المعلومات اللازمة لتفادي انقطاع خطوات الحجز.</p>
        <h2>ما الذي تحتاج إلى تجهيزه؟</h2>
        <ul>
          <li>العيادة والطبيب اللذان ترغب في اختيارهما.</li>
          <li>وسيلة تواصل واحدة على الأقل: رقم هاتف أو بريد إلكتروني.</li>
          <li>
            إذا اخترت وسيلة تواصل مفضلة، فتأكد من إدخال رقم الهاتف أو البريد
            الإلكتروني المطابق لها.
          </li>
        </ul>
        <p>صفحة المساعدة هذه لا تطلب أي دفع أو كلمة مرور أو مستند طبي.</p>
      </section>
    </main>
  );
}
