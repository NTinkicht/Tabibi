type Locale = 'fr' | 'ar';

type Copy = {
  dir: 'ltr' | 'rtl';
  title: string;
  intro: string;
  queueHeading: string;
  queueBody: string;
  consultationHeading: string;
  consultationBody: string;
  verificationHeading: string;
  verificationBody: string;
  recoveryHeading: string;
  recoveryBody: string;
  privacyHeading: string;
  privacyBody: string;
};

const COPY: Record<Locale, Copy> = {
  fr: {
    dir: 'ltr',
    title: 'Comprendre vos estimations Tabibi',
    intro:
      'Les temps affichés sont des estimations qui évoluent avec la file réelle. Ils ne constituent pas une heure de passage garantie.',
    queueHeading: 'Temps d’attente',
    queueBody:
      'La fourchette d’attente est recalculée à partir de l’état validé de la file (ordre et durées observées disponibles) au moment du calcul. Une urgence, une pause ou une consultation plus longue peut la faire évoluer.',
    consultationHeading: 'Consultation en cours',
    consultationBody:
      'Le temps restant est une approximation fondée sur l’état validé de votre consultation (durée attendue et temps déjà écoulé) au moment du calcul. La durée réelle dépend de la consultation.',
    verificationHeading: 'Dernière vérification du statut',
    verificationBody:
      'Cette heure indique la dernière fois où Tabibi a réussi à vérifier votre statut auprès de la file sécurisée. Elle ne garantit pas que le statut est encore à jour ni une heure précise de passage. Si un avertissement de connexion ou de statut potentiellement obsolète apparaît, l’heure reste celle de la dernière vérification réussie jusqu’à une nouvelle actualisation confirmée.',
    recoveryHeading: 'Si le statut n’est plus à jour',
    recoveryBody:
      'Revenez à votre page sécurisée de suivi de file et utilisez « Actualiser mon statut » ou « Réessayer maintenant ». Attendez une nouvelle vérification réussie avant de vous fier à une estimation actualisée. L’heure de la dernière vérification ne garantit pas la situation présente.',
    privacyHeading: 'Votre vie privée',
    privacyBody:
      'Ces explications n’affichent ni identité d’un autre patient, ni motif de consultation, ni donnée clinique.',
  },
  ar: {
    dir: 'rtl',
    title: 'فهم تقديرات طبيبي',
    intro:
      'الأوقات المعروضة تقديرات تتغير مع حالة الطابور الفعلية، وليست موعدًا مضمونًا للدخول.',
    queueHeading: 'وقت الانتظار',
    queueBody:
      'يُعاد حساب نطاق الانتظار اعتمادًا على الحالة المعتمدة للطابور (الترتيب والمدد المرصودة المتاحة) وقت الحساب. قد يتغير بسبب حالة طارئة أو توقف مؤقت أو استشارة أطول من المتوقع.',
    consultationHeading: 'الاستشارة جارية',
    consultationBody:
      'الوقت المتبقي تقريب يعتمد على الحالة المعتمدة لاستشارتك (المدة المتوقعة والوقت المنقضي) وقت الحساب. المدة الفعلية تعتمد على الاستشارة نفسها.',
    verificationHeading: 'آخر تحقق من الحالة',
    verificationBody:
      'يشير هذا الوقت إلى آخر مرة نجح فيها طبيبي في التحقق من حالتك عبر الطابور الآمن. لا يضمن أن الحالة لا تزال محدّثة ولا يحدد موعدًا مضمونًا للدخول. عند ظهور تنبيه بانقطاع الاتصال أو احتمال قِدم الحالة، يبقى وقت آخر تحقق ناجح كما هو حتى يكتمل تحديث جديد مؤكّد.',
    recoveryHeading: 'إذا لم تعد الحالة محدّثة',
    recoveryBody:
      'ارجع إلى صفحة متابعة الطابور الآمنة واستخدم « تحديث حالتي » أو « إعادة المحاولة الآن ». انتظر نجاح تحقق جديد قبل الاعتماد على تقدير محدّث. وقت آخر تحقق لا يضمن أن الحالة المعروضة هي الحالة الحالية.',
    privacyHeading: 'خصوصيتك',
    privacyBody:
      'لا تعرض هذه التوضيحات هوية أي مريض آخر أو سبب الاستشارة أو أي بيانات سريرية.',
  },
};

/**
 * Explain bilingual queue estimates and the limits of last-verified timestamps
 * without accepting or rendering any guest bearer or patient identifiers.
 */
export default async function GuestEtaExplainedPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const params = await searchParams;
  const lang = typeof params.lang === 'string' ? params.lang.trim() : '';
  const locale: Locale = /^ar(?:[-_]|$)/i.test(lang) ? 'ar' : 'fr';
  const copy = COPY[locale];

  return (
    <main lang={locale} dir={copy.dir}>
      <h1>{copy.title}</h1>
      <p>{copy.intro}</p>
      <section aria-labelledby="queue-estimate-heading">
        <h2 id="queue-estimate-heading">{copy.queueHeading}</h2>
        <p>{copy.queueBody}</p>
      </section>
      <section aria-labelledby="consultation-estimate-heading">
        <h2 id="consultation-estimate-heading">{copy.consultationHeading}</h2>
        <p>{copy.consultationBody}</p>
      </section>
      <section aria-labelledby="verification-heading">
        <h2 id="verification-heading">{copy.verificationHeading}</h2>
        <p>{copy.verificationBody}</p>
      </section>
      <section aria-labelledby="recovery-heading">
        <h2 id="recovery-heading">{copy.recoveryHeading}</h2>
        <p>{copy.recoveryBody}</p>
      </section>
      <section aria-labelledby="privacy-heading">
        <h2 id="privacy-heading">{copy.privacyHeading}</h2>
        <p>{copy.privacyBody}</p>
      </section>
      <nav aria-label={locale === 'ar' ? 'اللغة' : 'Langue'}>
        <a href="?lang=fr" lang="fr">
          Français
        </a>{' '}
        <a href="?lang=ar" lang="ar">
          العربية
        </a>
      </nav>
    </main>
  );
}
