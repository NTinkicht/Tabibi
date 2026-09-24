import Link from 'next/link';

export default function GuestPrivacyHelpPage() {
  return (
    <main>
      <section lang="fr" dir="ltr" aria-labelledby="privacy-help-fr">
        <h1 id="privacy-help-fr">
          Protéger vos informations pendant le parcours invité
        </h1>
        <ul>
          <li>
            Utilisez uniquement les écrans Tabibi prévus pour votre réservation
            et votre file d’attente.
          </li>
          <li>
            Ne partagez jamais votre mot de passe, un code d’accès ou des
            documents médicaux dans un champ non prévu.
          </li>
          <li>
            Fermez la page sur un appareil partagé lorsque vous avez terminé.
          </li>
        </ul>
        <Link href="/guest/booking-contact-help">
          Revenir à l’aide sur les coordonnées
        </Link>
        <div>
          <Link href="/guest/booking-help">Revenir à la préparation</Link>
        </div>
      </section>
      <section lang="ar" dir="rtl" aria-labelledby="privacy-help-ar">
        <h1 id="privacy-help-ar">حماية معلوماتك أثناء استخدام مسار الضيف</h1>
        <ul>
          <li>استخدم فقط شاشات طبيبي المخصصة للحجز وقائمة الانتظار.</li>
          <li>
            لا تشارك كلمة المرور أو رمز الدخول أو المستندات الطبية في حقل غير
            مخصص لذلك.
          </li>
          <li>أغلق الصفحة عند الانتهاء إذا كنت تستخدم جهازاً مشتركاً.</li>
        </ul>
        <Link href="/guest/booking-contact-help">
          العودة إلى مساعدة بيانات التواصل
        </Link>
        <div>
          <Link href="/guest/booking-help">العودة إلى التحضير</Link>
        </div>
      </section>
    </main>
  );
}
