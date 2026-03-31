import { Routes } from '@angular/router';
import { LandingComponent } from './components/landing/landing.component';
import { ChatComponent } from './components/chat/chat.component';

export const routes: Routes = [
  { path: '', component: LandingComponent },
  { path: 'chat', component: ChatComponent },
  { path: '**', redirectTo: '' }
];
