export type SignInLocale = 'ar' | 'fr';

export const signInStrings = {
  fr: {
    title: 'Connexion du personnel',
    subtitle: 'Accédez au tableau de bord de la clinique.',
    subject: 'Identifiant',
    password: 'Mot de passe',
    submit: 'Se connecter',
    submitting: 'Connexion en cours…',
    errorSummary: 'Connexion impossible',
    failed:
      'Identifiant ou mot de passe incorrect, ou compte temporairement verrouillé.',
    rateLimited: 'Trop de tentatives. Réessayez plus tard.',
    unavailable: 'Service indisponible. Réessayez dans un instant.',
    noClinic: 'Aucune clinique n’est associée à ce compte.',
    help: 'Mot de passe oublié ou compte verrouillé : demandez à l’administrateur de la clinique.',
    otherLanguage: 'العربية',
  },
  ar: {
    title: 'تسجيل دخول الموظفين',
    subtitle: 'ادخل إلى لوحة تحكم العيادة.',
    subject: 'المعرّف',
    password: 'كلمة المرور',
    submit: 'تسجيل الدخول',
    submitting: 'جارٍ تسجيل الدخول…',
    errorSummary: 'تعذّر تسجيل الدخول',
    failed: 'المعرّف أو كلمة المرور غير صحيحة، أو الحساب مقفل مؤقتًا.',
    rateLimited: 'محاولات كثيرة. حاول لاحقًا.',
    unavailable: 'الخدمة غير متاحة. حاول بعد قليل.',
    noClinic: 'لا توجد عيادة مرتبطة بهذا الحساب.',
    help: 'نسيت كلمة المرور أو الحساب مقفل؟ اطلب المساعدة من مسؤول العيادة.',
    otherLanguage: 'Français',
  },
} as const;
