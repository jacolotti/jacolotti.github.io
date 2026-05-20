/*
  /saved-tools.js
  Shared auth + save/load/delete logic for AutomationCalculators.net
*/

let savedToolsCurrentUser = null;
let savedToolsAuthMode = "signin";
let savedToolsActiveConfig = null;

function savedToolsSetStatus(id, message, type){
  const el = document.getElementById(id);
  if(!el) return;
  el.textContent = message || "";
  el.className = "save-status " + (type || "muted");
}

function savedToolsSafeValue(value){
  if(value === undefined || value === null || value === "") return "—";

  if(typeof value === "number"){
    return Number(value).toLocaleString(undefined, {
      maximumFractionDigits: 3
    });
  }

  return String(value);
}

function savedToolsEnsureAuthModal(){
  if(document.getElementById("authModal")) return;

  const modal = document.createElement("div");
  modal.id = "authModal";
  modal.className = "auth-modal-backdrop";
  modal.innerHTML = `
    <div class="auth-modal">
      <div class="auth-modal-head">
        <div>
          <h2>Automation Calculators Account</h2>
          <div class="saved-user">Sign in or create an account to save calculations.</div>
        </div>
        <button class="close-btn" type="button" onclick="closeAuthModal()">×</button>
      </div>

      <div class="auth-tabs">
        <button id="signInTab" class="auth-tab active" type="button" onclick="setAuthMode('signin')">Sign In</button>
        <button id="signUpTab" class="auth-tab" type="button" onclick="setAuthMode('signup')">Create Account</button>
      </div>

      <div class="auth-field">
        <label for="authEmail">Email</label>
        <input id="authEmail" type="email" autocomplete="email">
      </div>

      <div class="auth-field">
        <label for="authPassword">Password</label>
        <input id="authPassword" type="password" autocomplete="current-password">
      </div>

      <div class="button-row">
        <button id="authSubmitButton" class="btn btn-primary" type="button" onclick="submitAuthForm()">Sign In</button>
        <button class="btn btn-secondary" type="button" onclick="closeAuthModal()">Cancel</button>
      </div>

      <div id="authStatus" class="save-status muted"></div>
    </div>
  `;

  document.body.appendChild(modal);
}

function openAuthModal(){
  savedToolsEnsureAuthModal();
  document.getElementById("authModal").classList.add("active");
  savedToolsSetStatus("authStatus", "", "muted");
}

function closeAuthModal(){
  const modal = document.getElementById("authModal");
  if(modal) modal.classList.remove("active");
}

function setAuthMode(mode){
  savedToolsAuthMode = mode;

  const signInTab = document.getElementById("signInTab");
  const signUpTab = document.getElementById("signUpTab");
  const submitButton = document.getElementById("authSubmitButton");

  if(signInTab) signInTab.classList.toggle("active", mode === "signin");
  if(signUpTab) signUpTab.classList.toggle("active", mode === "signup");
  if(submitButton) submitButton.textContent = mode === "signin" ? "Sign In" : "Create Account";

  savedToolsSetStatus("authStatus", "", "muted");
}

async function submitAuthForm(){
  if(savedToolsAuthMode === "signup"){
    await savedToolsSignUpUser();
  } else {
    await savedToolsSignInUser();
  }
}

async function savedToolsSignUpUser(){
  const email = document.getElementById("authEmail")?.value.trim();
  const password = document.getElementById("authPassword")?.value;

  if(!email || !password){
    savedToolsSetStatus("authStatus", "Enter an email and password.", "error");
    return;
  }

  if(!window.supabaseClient){
    savedToolsSetStatus("authStatus", "Supabase is not loaded. Check /supabase.js.", "error");
    return;
  }

  const { error } = await supabaseClient.auth.signUp({
    email: email,
    password: password
  });

  if(error){
    savedToolsSetStatus("authStatus", error.message, "error");
    return;
  }

  if(typeof gtag === "function"){
    gtag("event", "account_signup_started", {
      location: savedToolsActiveConfig?.analyticsTool || "saved_tools"
    });
  }

  savedToolsSetStatus("authStatus", "Account created. Check your email to confirm your account, then sign in.", "success");
}

async function savedToolsSignInUser(){
  const email = document.getElementById("authEmail")?.value.trim();
  const password = document.getElementById("authPassword")?.value;

  if(!email || !password){
    savedToolsSetStatus("authStatus", "Enter your email and password.", "error");
    return;
  }

  if(!window.supabaseClient){
    savedToolsSetStatus("authStatus", "Supabase is not loaded. Check /supabase.js.", "error");
    return;
  }

  const { error } = await supabaseClient.auth.signInWithPassword({
    email: email,
    password: password
  });

  if(error){
    savedToolsSetStatus("authStatus", error.message, "error");
    return;
  }

  closeAuthModal();

  if(typeof gtag === "function"){
    gtag("event", "account_login", {
      location: savedToolsActiveConfig?.analyticsTool || "saved_tools"
    });
  }

  savedToolsSetStatus("saveStatus", "Signed in. You can now save this calculation.", "success");

  if(savedToolsActiveConfig){
    await savedToolsLoad(savedToolsActiveConfig);
  }
}

async function savedToolsCheckUser(){
  if(!window.supabaseClient){
    savedToolsCurrentUser = null;
    savedToolsUpdateAuthUI();
    savedToolsSetStatus("savedStatus", "Supabase is not loaded. Check /supabase.js.", "error");
    return null;
  }

  const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();

  if(sessionError){
    console.error("Session check error:", sessionError);
  }

  if(sessionData?.session?.user){
    savedToolsCurrentUser = sessionData.session.user;
    savedToolsUpdateAuthUI();
    return savedToolsCurrentUser;
  }

  savedToolsCurrentUser = null;
  savedToolsUpdateAuthUI();
  return null;
}

function savedToolsUpdateAuthUI(){
  const authButton = document.getElementById("authButton");
  const authUserLabel = document.getElementById("authUserLabel");

  if(savedToolsCurrentUser){
    if(authButton) authButton.textContent = "My Account";
    if(authUserLabel) authUserLabel.textContent = "Signed in as " + savedToolsCurrentUser.email;
  } else {
    if(authButton) authButton.textContent = "Sign In";
    if(authUserLabel) authUserLabel.textContent = "Sign in to save and reload calculations.";
  }
}

function savedToolsHandleAuthButton(config){
  savedToolsActiveConfig = config;

  if(savedToolsCurrentUser){
    savedToolsLoad(config);
    savedToolsSetStatus("savedStatus", "You are signed in. Your saved calculations are shown below.", "success");
  } else {
    openAuthModal();
  }
}

async function savedToolsSave(config){
  savedToolsActiveConfig = config;

  if(!config || !config.toolName || !config.toolUrl || typeof config.collectData !== "function"){
    savedToolsSetStatus("saveStatus", "Save setup is missing required tool configuration.", "error");
    return;
  }

  const savedData = config.collectData();

  if(!savedData){
    savedToolsSetStatus("saveStatus", "Calculate first or fix the inputs before saving.", "error");
    return;
  }

  const user = await savedToolsCheckUser();

  if(!user){
    savedToolsSetStatus("saveStatus", "Sign in to save this calculation.", "error");
    openAuthModal();
    return;
  }

  savedToolsSetStatus("saveStatus", "Saving calculation...", "muted");

  const { data, error } = await supabaseClient
    .from("saved_tools")
    .insert({
      user_id: user.id,
      tool_name: config.toolName,
      tool_url: config.toolUrl,
      saved_data: savedData
    })
    .select();

  console.log("Save response:", { data, error });

  if(error){
    savedToolsSetStatus("saveStatus", "Save failed: " + error.message, "error");
    return;
  }

  if(typeof gtag === "function"){
    gtag("event", "calculation_saved", {
      tool: config.analyticsTool || config.toolUrl,
      tool_url: config.toolUrl
    });
  }

  savedToolsSetStatus("saveStatus", "Calculation saved successfully.", "success");
  await savedToolsLoad(config);
}

async function savedToolsLoad(config){
  savedToolsActiveConfig = config;

  if(!config || !config.toolUrl){
    savedToolsSetStatus("savedStatus", "Saved tool configuration is missing.", "error");
    return;
  }

  const user = await savedToolsCheckUser();

  const list = document.getElementById("savedList");
  if(list) list.innerHTML = "";

  if(!user){
    savedToolsSetStatus("savedStatus", "Sign in to view saved calculations.", "muted");
    return;
  }

  savedToolsSetStatus("savedStatus", "Loading saved calculations...", "muted");

  const { data, error } = await supabaseClient
    .from("saved_tools")
    .select("id, tool_name, tool_url, saved_data, created_at")
    .eq("user_id", user.id)
    .eq("tool_url", config.toolUrl)
    .order("created_at", { ascending:false });

  if(error){
    savedToolsSetStatus("savedStatus", "Could not load saved calculations: " + error.message, "error");
    return;
  }

  if(!data || data.length === 0){
    savedToolsSetStatus("savedStatus", "No saved calculations yet.", "muted");
    return;
  }

  savedToolsSetStatus("savedStatus", data.length + " saved calculation" + (data.length === 1 ? "" : "s") + " found.", "success");

  data.forEach(item => {
    savedToolsRenderItem(item, config);
  });
}

function savedToolsRenderItem(item, config){
  const list = document.getElementById("savedList");
  if(!list) return;

  const d = item.saved_data || {};
  const createdDate = item.created_at ? new Date(item.created_at) : null;
  const createdLabel = createdDate ? createdDate.toLocaleString() : "Saved calculation";

  const div = document.createElement("div");
  div.className = "saved-item";

  const titleRow = document.createElement("div");
  titleRow.className = "saved-title-row";

  const titleWrap = document.createElement("div");

  const title = document.createElement("div");
  title.className = "saved-title";
  title.textContent = config.savedItemTitle || config.toolName || "Saved Calculation";

  const meta = document.createElement("div");
  meta.className = "saved-meta";
  meta.textContent = createdLabel;

  titleWrap.appendChild(title);
  titleWrap.appendChild(meta);
  titleRow.appendChild(titleWrap);

  const values = document.createElement("div");
  values.className = "saved-values";

  const fields = typeof config.renderFields === "function"
    ? config.renderFields(d)
    : savedToolsDefaultFields(d);

  fields.forEach(field => {
    const box = document.createElement("div");
    box.className = "saved-value";

    const label = document.createElement("strong");
    label.textContent = field.label + ":";

    const br = document.createElement("br");
    const value = document.createTextNode(field.value);

    box.appendChild(label);
    box.appendChild(br);
    box.appendChild(value);
    values.appendChild(box);
  });

  const actions = document.createElement("div");
  actions.className = "saved-actions";

  const reloadBtn = document.createElement("button");
  reloadBtn.className = "btn btn-primary";
  reloadBtn.type = "button";
  reloadBtn.textContent = "Reload Setup";
  reloadBtn.addEventListener("click", function(){
    if(typeof config.reloadData === "function"){
      config.reloadData(d);
    }

    if(typeof gtag === "function"){
      gtag("event", "saved_calculation_reloaded", {
        tool: config.analyticsTool || config.toolUrl,
        tool_url: config.toolUrl
      });
    }

    savedToolsSetStatus("saveStatus", "Saved setup reloaded.", "success");

    const calculator = document.getElementById("calculator");
    if(calculator){
      calculator.scrollIntoView({
        behavior:"smooth",
        block:"start"
      });
    }
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn btn-danger";
  deleteBtn.type = "button";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", function(){
    savedToolsDelete(item.id, config);
  });

  actions.appendChild(reloadBtn);
  actions.appendChild(deleteBtn);

  div.appendChild(titleRow);
  div.appendChild(values);
  div.appendChild(actions);

  list.appendChild(div);
}

function savedToolsDefaultFields(d){
  return Object.keys(d).slice(0, 8).map(key => {
    return {
      label: key.replaceAll("_", " "),
      value: savedToolsSafeValue(d[key])
    };
  });
}

async function savedToolsDelete(id, config){
  const user = await savedToolsCheckUser();

  if(!user){
    openAuthModal();
    return;
  }

  const { error } = await supabaseClient
    .from("saved_tools")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if(error){
    savedToolsSetStatus("savedStatus", "Delete failed: " + error.message, "error");
    return;
  }

  if(typeof gtag === "function"){
    gtag("event", "saved_calculation_deleted", {
      tool: config.analyticsTool || config.toolUrl,
      tool_url: config.toolUrl
    });
  }

  savedToolsSetStatus("savedStatus", "Saved calculation deleted.", "success");
  await savedToolsLoad(config);
}

async function savedToolsSignOut(){
  if(!window.supabaseClient){
    savedToolsSetStatus("savedStatus", "Supabase is not loaded.", "error");
    return;
  }

  const { error } = await supabaseClient.auth.signOut();

  if(error){
    savedToolsSetStatus("savedStatus", "Sign out failed: " + error.message, "error");
    console.error("Sign out failed:", error);
    return;
  }

  savedToolsCurrentUser = null;
  savedToolsUpdateAuthUI();

  const list = document.getElementById("savedList");

  if(list){
    list.innerHTML = "";
  }

  savedToolsSetStatus("saveStatus", "", "muted");
  savedToolsSetStatus("savedStatus", "Signed out successfully.", "success");
}

function savedToolsInjectAuthStyles(){
  if(document.getElementById("savedToolsAuthStyles")) return;

  const style = document.createElement("style");
  style.id = "savedToolsAuthStyles";
  style.textContent = `
    .auth-modal-backdrop{
      display:none;
      position:fixed;
      inset:0;
      background:rgba(15, 23, 42, 0.58);
      z-index:9999;
      align-items:center;
      justify-content:center;
      padding:18px;
    }

    .auth-modal-backdrop.active{
      display:flex;
    }

    .auth-modal{
      width:min(480px, 100%);
      background:white;
      border:1px solid var(--border, #d9e3ee);
      border-radius:18px;
      box-shadow:0 24px 70px rgba(15, 23, 42, 0.28);
      padding:24px;
      color:var(--text, #16202a);
      font-family:Arial, Helvetica, sans-serif;
    }

    .auth-modal-head{
      display:flex;
      justify-content:space-between;
      align-items:flex-start;
      gap:12px;
      margin-bottom:14px;
    }

    .auth-modal h2{
      margin:0 0 4px;
      font-size:1.5rem;
    }

    .close-btn{
      border:0;
      background:var(--soft, #edf4fb);
      color:var(--text, #16202a);
      border-radius:10px;
      padding:8px 11px;
      font-weight:800;
      cursor:pointer;
    }

    .auth-tabs{
      display:flex;
      gap:8px;
      margin:14px 0 18px;
    }

    .auth-tab{
      flex:1;
      border:1px solid var(--border, #d9e3ee);
      background:white;
      border-radius:10px;
      padding:10px;
      font-weight:800;
      cursor:pointer;
      color:var(--accent-dark, #084c92);
    }

    .auth-tab.active{
      background:var(--accent, #0b66c3);
      color:white;
      border-color:var(--accent, #0b66c3);
    }

    .auth-field{
      margin-bottom:12px;
    }

    .auth-field label{
      display:block;
      font-weight:700;
      margin-bottom:6px;
    }

    .auth-field input{
      width:100%;
      padding:10px 12px;
      font-size:16px;
      box-sizing:border-box;
      border:1px solid #cfd6e4;
      border-radius:8px;
      background:white;
      font-family:Arial, Helvetica, sans-serif;
    }

    .auth-field input:focus{
      outline:none;
      border-color:#5a78b5;
      box-shadow:0 0 0 3px rgba(90,120,181,0.12);
    }
  `;

  document.head.appendChild(style);
}

function savedToolsInit(config){
  savedToolsActiveConfig = config;

  document.addEventListener("DOMContentLoaded", async function(){
    savedToolsInjectAuthStyles();
    savedToolsEnsureAuthModal();

    await savedToolsCheckUser();
    await savedToolsLoad(config);

    if(window.supabaseClient && supabaseClient.auth && supabaseClient.auth.onAuthStateChange){
      supabaseClient.auth.onAuthStateChange(async function(event, session){
        savedToolsCurrentUser = session && session.user ? session.user : null;
        savedToolsUpdateAuthUI();

        if(event === "SIGNED_IN"){
          await savedToolsLoad(config);
        }

        if(event === "SIGNED_OUT"){
          const list = document.getElementById("savedList");
          if(list) list.innerHTML = "";
          savedToolsSetStatus("savedStatus", "Sign in to view saved calculations.", "muted");
        }
      });
    }
  });
}
