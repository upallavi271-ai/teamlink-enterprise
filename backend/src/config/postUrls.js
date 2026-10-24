// ---------------------------------------------------------------------------
// WHERE "POST" OPENS EACH JOB SITE - the ONE list (founder, 2026-10-23: "put the URLs in one config, so when a site changes one of them,
// one place changes").  Read by utils/jobBoards/guide.js (the by-hand help and the Naukri -> Shine flow) and by jobDist/platforms.js (the
// platform table).  TeamLink only OPENS these pages; the person signs in and posts there, and says "I posted it" here.
//
// CHECKED 2026-10-23 (the page answers, and its own title says what it is):
//   naukri    recruiter login. Naukri has NO direct "post a job" address: after signing in the person opens Jobs & Responses > Post a Job.
//   indeed    Indeed for Employers India: "Post a job" landing (it redirects to /hire/cs). Sign-in is on that page.
//   linkedin  LinkedIn Talent Solutions: asks for sign-in, then offers Post a job. (Landing page confirmed; the page after sign-in was not seen.)
//   shine     Shine recruiter / employer login.
//   foundit   foundit.in recruiter page.
// The company's own careers page / Job Portal is NOT here: it is the company's own address, set in the Job Portal settings.
// ---------------------------------------------------------------------------
const POST_URLS = {
  naukri: 'https://www.naukri.com/recruit/login',
  linkedin: 'https://www.linkedin.com/talent/post-a-job',
  shine: 'https://recruiter.shine.com/',
  indeed: 'https://in.indeed.com/hire',
  foundit: 'https://recruiter.foundit.in/',
};

module.exports = { POST_URLS };
